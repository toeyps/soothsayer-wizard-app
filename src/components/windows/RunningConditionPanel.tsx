import { Fragment } from 'react';
import { Plus, X } from 'lucide-react';
import type { TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { validatePeriods } from '../../utils/timePeriods';
import { SensorPickerModal } from './SensorPickers';
import { RuleSentence } from './RunningConditionParts';
import TimePeriodsEditor, { type PeriodBounds } from './TimePeriodsEditor';
import { formatPercent, type RowCountPreview } from './useRowCountPreview';

/*
 * Body of BuildModelWindow's "Running condition" settings modal — the
 * 2026-10-03 redesign (approved mockup 1pp59aydphzaDu2R1SvKGh): two columns.
 *   left   "1 Which time"  (period cards)  and  "2 When the plant is running"
 *          (two choice cards, condition rows, AND/OR pill between rows)
 *   right  "Data used for training": row count + bar, summary sentence, warnings
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
}

export default function RunningConditionPanel({
    configured, periods, onPeriodsChange, bounds, filters, combine, noneConfirmed,
    onNoneChange, onCombineChange, onAddFilter, onUpdateFilter, onRemoveFilter, sensors, getDesc, getComponent, getUnit,
    preview,
}: RunningConditionPanelProps) {
    const status = validatePeriods(periods);
    const firstBad = status.findIndex(s => s.invalid);
    const validCount = status.filter(s => !s.invalid).length;
    const headers = sensors.length ? sensors : null;
    const label = (tag: string) => getDesc(tag) || tag;

    const hasCount = preview.used !== null && preview.total !== null && (preview.status === 'ok' || preview.status === 'loading');
    const pct = hasCount && preview.total ? Math.min(100, ((preview.used ?? 0) / preview.total) * 100) : 0;

    return (
        <div data-testid="rc-panel" className="rcm-body">
            <div className="rcm-form">
                <section className="rcm-step" data-testid="rc-periods">
                    <div className="rcm-step-h">
                        <span className="rcm-num">1</span>
                        <b>Which time</b>
                        <span className="rcm-q">Training periods · optional — a row inside any period is used · none = whole dataset</span>
                    </div>
                    <TimePeriodsEditor periods={periods} onChange={onPeriodsChange} bounds={bounds} />
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
                                    ? `The ${validCount} period${validCount > 1 ? 's' : ''} above still limit${validCount > 1 ? '' : 's'} the time.`
                                    : 'No periods are set, so that means the full dataset.'}
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
                <div className="rcm-pv-h">Data used for training</div>
                <div className="rcm-big" data-testid="rc-preview-count" aria-live="polite">
                    {hasCount ? (
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
