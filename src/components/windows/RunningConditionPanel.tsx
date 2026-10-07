import { Fragment } from 'react';
import { Plus, X } from 'lucide-react';
import type { TestPeriod, TimeHighlight, TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { validatePeriods } from '../../utils/timePeriods';
import { RECOMMENDED_TRAIN_DAYS, trainDaysWarning } from '../../utils/trainTestValidation';
import { estimateRunningDays } from './periodDisplay';
import { SensorPickerModal } from './SensorPickers';
import { RuleSentence, TrainHighlightWarnings } from './RunningConditionParts';
import TestPeriodsEditor from './TestPeriodsEditor';
import TimePeriodsEditor, { type PeriodBounds } from './TimePeriodsEditor';
import { formatPercent, type RowCountPreview } from './useRowCountPreview';

/*
 * Body of BuildModelWindow's "Running condition" settings modal — the
 * 2026-10-03 redesign (approved mockup 1pp59aydphzaDu2R1SvKGh): two columns.
 *   left   "1 Which time"  (TRAIN period cards + TEST period rows, Train/Test
 *          validation 2026-10-07)  and  "2 When the plant is running"
 *          (two choice cards, condition rows, AND/OR pill between rows)
 *   right  "Data used for training": row count + bar, summary sentence, the test
 *          summary, the recommended-train-days note, warnings
 * Presentation only: every value and handler arrives through props from
 * BuildModelWindow, which feeds it the modal's local DRAFT (nothing here
 * writes anything — Apply lives in the modal footer).
 */

type Operation = WorkspaceSensorFilter['operation'];

const OPERATORS: { op: Operation; glyph: string; label: string }[] = [
    { op: 'greater_than', glyph: '>', label: 'Greater than' },
    { op: 'less_than', glyph: '<', label: 'Less than' },
    { op: 'between', glyph: '↔', label: 'Between' },
    { op: 'equals', glyph: '=', label: 'Equals' },
];

/** Header pills of the modal: Fix period / Required / "No condition" / "N conditions". */
export function RunningConditionPills({ configured, noneConfirmed, conditionCount, periodInvalid }: {
    configured: boolean;
    noneConfirmed: boolean;
    conditionCount: number;
    periodInvalid: boolean;
}) {
    return (
        <>
            {periodInvalid && <span data-testid="rc-fix-period-pill" className="f4-pill f4-pill--bad">Fix period</span>}
            {!configured
                ? <span data-testid="rc-required-pill" className="f4-pill f4-pill--warn">Required</span>
                : noneConfirmed
                ? <span data-testid="rc-none-pill" className="f4-pill f4-pill--grey">No condition</span>
                : <span data-testid="rc-count-pill" className="f4-pill f4-pill--blue">{conditionCount} condition{conditionCount === 1 ? '' : 's'}</span>}
        </>
    );
}

interface RunningConditionPanelProps {
    /** Workspace running condition (as drafted) is configured. */
    configured: boolean;
    periods: TimePeriod[];
    onPeriodsChange: (next: TimePeriod[]) => void;
    bounds: PeriodBounds | null;
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    noneConfirmed: boolean;
    onNoneChange: (none: boolean) => void;
    onCombineChange: (mode: 'and' | 'or') => void;
    onAddFilter: () => void;
    onUpdateFilter: (id: string, patch: Partial<WorkspaceSensorFilter>) => void;
    onRemoveFilter: (id: string) => void;
    sensors: string[];
    getDesc: (tag: string) => string;
    getComponent: (tag: string) => string;
    getUnit: (tag: string) => string;
    /** Row count of what Apply would commit (the draft). */
    preview: RowCountPreview;
    /** Test periods (draft) — where the score is checked; never trained on. */
    testPeriods: TestPeriod[];
    onTestPeriodsChange: (next: TestPeriod[]) => void;
    /** The workspace's Dashboard time highlights ("From Highlights", train-overlap warning). */
    highlights: TimeHighlight[];
    /** The "From Highlights" menu opened (the host may re-read the highlights). */
    onHighlightsMenuOpen?: () => void;
}

export default function RunningConditionPanel({
    configured, periods, onPeriodsChange, bounds, filters, combine, noneConfirmed,
    onNoneChange, onCombineChange, onAddFilter, onUpdateFilter, onRemoveFilter, sensors, getDesc, getComponent, getUnit,
    preview, testPeriods, onTestPeriodsChange, highlights, onHighlightsMenuOpen,
}: RunningConditionPanelProps) {
    const status = validatePeriods(periods);
    const firstBad = status.findIndex(s => s.invalid);
    const validCount = status.filter(s => !s.invalid).length;
    const headers = sensors.length ? sensors : null;
    const label = (tag: string) => getDesc(tag) || tag;

    // No train period = nothing to train on (rule 1): never show a whole-dataset count.
    const noTrain = periods.length === 0;
    const hasCount = !noTrain && preview.used !== null && preview.total !== null && (preview.status === 'ok' || preview.status === 'loading');
    const pct = hasCount && preview.total ? Math.min(100, ((preview.used ?? 0) / preview.total) * 100) : 0;
    // Recommended train running time (rule 12 — amber only, never a block),
    // estimated from the draft's row count until Rust has the exact figure.
    const trainDays = hasCount && preview.status === 'ok' ? estimateRunningDays(preview.used, preview.total, bounds) : null;
    const daysWarning = trainDaysWarning(trainDays);
    const nNormal = testPeriods.filter(t => t.label === 'normal').length;
    const nProblem = testPeriods.length - nNormal;

    return (
        <div data-testid="rc-panel" className="rcm-body">
            <div className="rcm-form">
                <section className="rcm-step" data-testid="rc-periods">
                    <div className="rcm-step-h">
                        <span className="rcm-num">1</span>
                        <b>Which time</b>
                        <span className="rcm-q">Train periods teach the model what normal looks like · test periods are when the score is checked</span>
                    </div>
                    <div className="tpe-sub" data-testid="rc-train-head">
                        <i className="tpe-sw tpe-sw--tr" aria-hidden="true" /><b>Train periods</b><span>required · at least one · a row inside any period is used</span>
                    </div>
                    <div className="tpe-callout" data-testid="rc-train-callout">
                        <b>Pick only times when the machine was healthy and running normally.</b> The model learns these rows as “normal” — a period with a problem in it teaches the model that the problem is normal, and the health score will miss it later.
                    </div>
                    <TimePeriodsEditor periods={periods} onChange={onPeriodsChange} bounds={bounds} tests={testPeriods} />
                    <TrainHighlightWarnings periods={periods} highlights={highlights} onPeriodsChange={onPeriodsChange} />

                    <div className="tpe-sub tpe-sub--te" data-testid="rc-test-head">
                        <i className="tpe-sw tpe-sw--te" aria-hidden="true" /><b>Test periods</b><span>when the score is checked · needed before Mark complete · may include train time</span>
                    </div>
                    <div className="tpe-callout tpe-callout--te">
                        Label each one. <b>Normal</b>: the score should stay high (shows false alarms). <b>Known problem</b>: the score should drop (shows the problem is caught) — add the event time to get the lead time.
                    </div>
                    <TestPeriodsEditor
                        tests={testPeriods}
                        train={periods}
                        onChange={onTestPeriodsChange}
                        highlights={highlights}
                        bounds={bounds}
                        onHighlightsMenuOpen={onHighlightsMenuOpen}
                    />
                </section>

                <section className="rcm-step" data-testid="rc-condition">
                    <div className="rcm-step-h">
                        <span className="rcm-num">2</span>
                        <b>When the plant is running</b>
                        <span className="rcm-q">required to build a model</span>
                    </div>

                    {/* Value conditions vs. an explicit "No condition" — exactly one is
                        active; a running condition is REQUIRED before any model can be
                        built (soft gate A). "Use all rows" clears nothing stored, it
                        just stops the saved conditions applying. */}
                    <div role="group" aria-label="Condition mode" className="rcm-mode">
                        {([
                            ['condition', 'Only when running', 'Keep rows that meet a condition, e.g. power above a level'],
                            ['none', 'Use all rows', 'No condition — idle and shutdown time included'],
                        ] as const).map(([mode, title, hint]) => {
                            const active = (mode === 'none') === noneConfirmed;
                            return (
                                <button
                                    key={mode}
                                    type="button"
                                    data-testid={`rc-mode-${mode}`}
                                    className={`rcm-mcard${active ? ' rcm-mcard--on' : ''}`}
                                    aria-pressed={active}
                                    onClick={() => { if ((mode === 'none') !== noneConfirmed) onNoneChange(mode === 'none'); }}
                                >
                                    <span className="rcm-rd" aria-hidden="true" />
                                    <span><b>{title}</b><small>{hint}</small></span>
                                </button>
                            );
                        })}
                    </div>

                    {noneConfirmed ? (
                        <div data-testid="rc-none-note" className="rcm-none">
                            <span>
                                <b>Every row inside the training periods is used</b>, idle time included.{' '}
                                {validCount > 0
                                    ? `The ${validCount} train period${validCount > 1 ? 's' : ''} above still limit${validCount > 1 ? '' : 's'} the time.`
                                    : 'There is no train period yet — add one above.'}
                                {filters.length > 0 && ' Your saved conditions are kept but not applied.'}
                            </span>
                        </div>
                    ) : (
                        <>
                            <div className="rcm-conds">
                                {filters.length === 0 && (
                                    <div className="rcm-none" data-testid="rc-no-conditions">
                                        <span>Add a condition that tells running from idle — for example <b>active power &gt; a level</b>.</span>
                                    </div>
                                )}
                                {filters.map((f, i) => {
                                    const incomplete = !isCompleteCondition(f, headers);
                                    const unit = getUnit(f.sensor);
                                    return (
                                        <Fragment key={f.id}>
                                            {i > 0 && (
                                                <div className="rcm-join">
                                                    <button
                                                        type="button"
                                                        className="rcm-joinbtn"
                                                        data-testid="rc-combine"
                                                        title="Switch between AND / OR"
                                                        aria-label={`Conditions are combined with ${combine.toUpperCase()} — click to switch to ${combine === 'and' ? 'OR' : 'AND'}`}
                                                        onClick={() => onCombineChange(combine === 'and' ? 'or' : 'and')}
                                                    >
                                                        {combine.toUpperCase()}
                                                    </button>
                                                    <small data-testid="rc-combine-caption">{combine === 'and' ? 'both must be true' : 'either one is enough'}</small>
                                                </div>
                                            )}
                                            <div className={`rcm-cond${f.operation === 'between' ? ' rcm-cond--between' : ''}${incomplete ? ' rcm-cond--incomplete' : ''}`} data-testid={`rc-cond-${i + 1}`}>
                                                <div className="rcm-cond-s">
                                                    <SensorPickerModal
                                                        sensors={sensors}
                                                        getDesc={getDesc}
                                                        getComponent={getComponent}
                                                        single
                                                        mutedTag
                                                        value={f.sensor}
                                                        onSelect={sensor => onUpdateFilter(f.id, { sensor })}
                                                        noun="sensor"
                                                    />
                                                    {getComponent(f.sensor) && <small className="rcm-cond-comp">{getComponent(f.sensor)}</small>}
                                                </div>
                                                <div role="group" aria-label="Condition operator" className="rcm-ops">
                                                    {OPERATORS.map(o => (
                                                        <button
                                                            key={o.op}
                                                            type="button"
                                                            className={f.operation === o.op ? 'on' : undefined}
                                                            aria-pressed={f.operation === o.op}
                                                            aria-label={o.label}
                                                            title={o.label}
                                                            onClick={() => { if (f.operation !== o.op) onUpdateFilter(f.id, { operation: o.op }); }}
                                                        >
                                                            {o.glyph}
                                                        </button>
                                                    ))}
                                                </div>
                                                <div className="rcm-vals">
                                                    <label className={`rcm-val${!(f.value1 ?? '').trim() ? ' rcm-val--empty' : ''}`}>
                                                        <input
                                                            type="number"
                                                            value={f.value1}
                                                            aria-label={f.operation === 'between' ? 'Minimum value' : 'Value'}
                                                            placeholder={f.operation === 'between' ? 'min' : 'value'}
                                                            onChange={e => onUpdateFilter(f.id, { value1: e.target.value })}
                                                        />
                                                        {f.operation !== 'between' && unit && <span>{unit}</span>}
                                                    </label>
                                                    {f.operation === 'between' && (
                                                        <>
                                                            <span className="rcm-dash" aria-hidden="true">–</span>
                                                            <label className={`rcm-val${!(f.value2 ?? '').trim() ? ' rcm-val--empty' : ''}`}>
                                                                <input
                                                                    type="number"
                                                                    value={f.value2}
                                                                    aria-label="Maximum value"
                                                                    placeholder="max"
                                                                    onChange={e => onUpdateFilter(f.id, { value2: e.target.value })}
                                                                />
                                                                {unit && <span>{unit}</span>}
                                                            </label>
                                                        </>
                                                    )}
                                                </div>
                                                <button type="button" className="rcm-ib" onClick={() => onRemoveFilter(f.id)} title="Remove condition" aria-label="Remove condition">
                                                    <X size={14} aria-hidden="true" />
                                                </button>
                                            </div>
                                        </Fragment>
                                    );
                                })}
                            </div>
                            <button type="button" className="rcm-add" data-testid="rc-add-condition" onClick={onAddFilter} disabled={sensors.length === 0}>
                                <Plus size={13} aria-hidden="true" />Add condition
                            </button>
                        </>
                    )}
                </section>
            </div>

            <aside className="rcm-preview" data-testid="rc-preview" aria-label="Data used for training">
                <div className="rcm-pv-h">Data used for training <span className="tpe-pvsub">train periods only</span></div>
                <div className="rcm-big" data-testid="rc-preview-count" aria-live="polite">
                    {noTrain ? (
                        <><b>0</b><span data-testid="rc-preview-no-train">rows — add a train period</span></>
                    ) : hasCount ? (
                        <>
                            <b className={preview.status === 'loading' ? 'rcm-stale' : undefined}>{(preview.used ?? 0).toLocaleString()}</b>
                            <span>of {(preview.total ?? 0).toLocaleString()} rows · {formatPercent(preview.used, preview.total)}</span>
                        </>
                    ) : preview.status === 'loading' ? (
                        <span data-testid="rc-preview-loading">Counting rows…</span>
                    ) : preview.status === 'error' ? (
                        <span data-testid="rc-preview-error" className="rcm-pv-muted">Couldn't count the rows right now.</span>
                    ) : (
                        <span data-testid="rc-preview-idle" className="rcm-pv-muted">{firstBad >= 0 ? 'Fix the period to see the row count.' : '—'}</span>
                    )}
                </div>
                <div className="rcm-meter" role="img" aria-label="Share of rows used"><span style={{ width: `${pct}%` }} /></div>
                <RuleSentence
                    periods={periods}
                    filters={filters}
                    combine={combine}
                    none={noneConfirmed}
                    headers={headers}
                    getLabel={label}
                    getUnit={getUnit}
                />
                {testPeriods.length > 0 ? (
                    <div className="tpe-pvtest" data-testid="rc-preview-tests">
                        <span className="tpe-pvtest-l"><i className="tpe-sw tpe-sw--te" aria-hidden="true" />Test</span>
                        <b>{testPeriods.length}</b>
                        <span>period{testPeriods.length === 1 ? '' : 's'} · {nNormal} Normal · {nProblem} Known problem</span>
                    </div>
                ) : (
                    <div className="tpe-pvtest tpe-pvtest--none" data-testid="rc-preview-tests">
                        No test period yet — you can train, but Mark complete needs one.
                    </div>
                )}
                <div className={`tpe-min${daysWarning ? ' tpe-min--warn' : ''}`} data-testid="rc-min-data">
                    {daysWarning ?? `At least ${RECOMMENDED_TRAIN_DAYS} d of train running time is recommended${trainDays !== null ? ` (about ${Math.round(trainDays)} d now)` : ''}.`}
                </div>
                {firstBad >= 0 && (
                    <div data-testid="rc-invalid-reason" className="rcm-warn rcm-warn--bad">
                        ⚠ {status[firstBad].reason ?? `Period ${firstBad + 1} is invalid.`} Models that follow this setting can't be built until it's fixed.
                    </div>
                )}
                {!configured && (
                    <div data-testid="rc-unset-warning" className="rcm-warn">
                        Choose “Only when running” with a condition, or “Use all rows”, before building a model.
                    </div>
                )}
            </aside>
        </div>
    );
}
