import { ChevronDown, Gauge, Plus, X } from 'lucide-react';
import type { TimePeriod, WorkspaceSensorFilter } from '../../types';
import { validatePeriods } from '../../utils/timePeriods';
import { SensorPickerModal } from './PredictiveModelBuild';
import { PeriodChipsLine, RuleFormula } from './RunningConditionParts';
import TimePeriodsEditor, { type PeriodBounds } from './TimePeriodsEditor';
import { conditionSymbol } from './periodDisplay';

/*
 * Overview "Running Condition Filter" panel - workspace default training
 * periods + value conditions. Visual spec: approved mockups time-ranges.html
 * and rc-gate.html. Presentation only: all state and persistence stay in
 * BuildModelWindow and arrive through props.
 */

interface RunningConditionPanelProps {
    open: boolean;
    onToggle: () => void;
    /** Workspace running condition is configured (>= 1 complete condition or "No condition" confirmed). */
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
}

export default function RunningConditionPanel({
    open, onToggle, configured, periods, onPeriodsChange, bounds, filters, combine, noneConfirmed,
    onNoneChange, onCombineChange, onAddFilter, onUpdateFilter, onRemoveFilter, sensors, getDesc, getComponent,
}: RunningConditionPanelProps) {
    const status = validatePeriods(periods);
    const firstBad = status.findIndex(s => s.invalid);
    const validCount = status.filter(s => !s.invalid).length;
    const label = (tag: string) => getDesc(tag) || tag;

    const condText = noneConfirmed
        ? 'No condition — every row in the periods'
        : filters.length === 0
        ? 'Not set — add a condition that tells running from idle, or choose "No condition — use all rows".'
        : filters.map(f => `${label(f.sensor)} ${conditionSymbol(f.operation)} ${f.operation === 'between' ? `${f.value1}–${f.value2}` : f.value1}`)
            .join(combine === 'or' ? ' OR ' : ' AND ');

    // The header pill owns the `rc-required-pill` test id; the copy inside the
    // body's "Running condition" block is the same pill under its own id.
    const pill = (testId: string) => !configured
        ? <span data-testid={testId} className="f4-pill f4-pill--warn">Required</span>
        : noneConfirmed
        ? <span className="f4-pill f4-pill--grey">No condition</span>
        : <span className="f4-pill f4-pill--blue">{filters.length} condition{filters.length === 1 ? '' : 's'}</span>;

    return (
        <div data-testid="rc-panel" className={`f4-rc ${configured ? 'f4-rc--set' : 'f4-rc--req'}`}>
            <div
                className="f4-rc-h"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={onToggle}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
            >
                <div className="f4-rc-t">
                    <div className="f4-ico"><Gauge size={15} /></div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="f4-ttl">Running Condition Filter</div>
                        <div className="f4-hline" data-testid="rc-summary">
                            {validCount > 0
                                ? <><PeriodChipsLine periods={periods} /><span style={{ color: 'var(--text-faint)' }}>·</span></>
                                : <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>Any time ·</span>}
                            <span className={`f4-hline-cx${!configured ? ' f4-hline-cx--warn' : ''}`}>{condText}</span>
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    {firstBad >= 0 && <span data-testid="rc-fix-period-pill" className="f4-pill f4-pill--bad">Fix period</span>}
                    {pill('rc-required-pill')}
                    <ChevronDown size={14} color="var(--text-faint)" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
                </div>
            </div>

            {open && (
                <div className="f4-rc-b">
                    <p className="f4-note">Workspace default for every model. A model can override all of it on its own Build page (Custom).</p>

                    <div className="f4-blk" data-testid="rc-periods">
                        <div className="f4-blk-h">
                            <span className="f4-blk-n">Training periods</span>
                            <span className="f4-count">{periods.length}</span>
                            <span className="f4-blk-hint">optional · a row inside <b>any</b> period is used · none = full dataset</span>
                        </div>
                        <TimePeriodsEditor periods={periods} onChange={onPeriodsChange} bounds={bounds} />
                    </div>

                    <div className="f4-divider" />

                    {/* Value conditions vs. an explicit "No condition" - exactly one is
                        active; a running condition is REQUIRED before any model can be
                        built (soft gate A). "No condition" clears nothing stored, it
                        just stops the saved conditions applying. */}
                    <div className="f4-blk">
                        <div className="f4-blk-h">
                            <span className="f4-blk-n">Running condition</span>
                            {pill('rc-required-pill-inline')}
                            <span className="f4-blk-hint">required to build · applied inside the periods above</span>
                        </div>
                        <div role="group" aria-label="Condition mode" className="f4-seg f4-seg--full">
                            {([['condition', 'Filter by condition'], ['none', 'No condition — use all rows']] as const).map(([mode, text]) => {
                                const active = (mode === 'none') === noneConfirmed;
                                return (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={active ? 'on' : undefined}
                                        aria-pressed={active}
                                        onClick={() => { if ((mode === 'none') !== noneConfirmed) onNoneChange(mode === 'none'); }}
                                    >
                                        {text}
                                    </button>
                                );
                            })}
                        </div>

                        {noneConfirmed ? (
                            <div className="f4-nofilter">
                                <div data-testid="rc-none-note" className="f4-note">
                                    <b style={{ color: 'var(--text-primary)' }}>Every row inside the training periods is used</b>, idle time included.{' '}
                                    {validCount > 0
                                        ? `The ${validCount} period${validCount > 1 ? 's' : ''} above still limit${validCount > 1 ? '' : 's'} the time.`
                                        : 'No periods are set, so that means the full dataset.'}
                                    {filters.length > 0 && ' Your saved conditions are kept but not applied.'}
                                </div>
                                <span className="f4-pill f4-pill--ok">✓ Confirmed</span>
                            </div>
                        ) : (
                            <>
                                <div className="f4-acts">
                                    <span className="f4-note">Match</span>
                                    <div className="f4-seg f4-seg--andor">
                                        {(['and', 'or'] as const).map(mode => (
                                            <button
                                                key={mode}
                                                type="button"
                                                className={combine === mode ? 'on' : undefined}
                                                aria-pressed={combine === mode}
                                                onClick={() => onCombineChange(mode)}
                                            >
                                                {mode.toUpperCase()}
                                            </button>
                                        ))}
                                    </div>
                                    <span className="f4-note f4-note--faint">— value conditions only; periods always combine with OR</span>
                                </div>

                                {filters.map(f => (
                                    <div key={f.id} className="f4-cond">
                                        <div className="f4-cond-s">
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
                                        </div>
                                        <select
                                            className="f4-cond-o"
                                            aria-label="Operator"
                                            value={f.operation}
                                            onChange={e => onUpdateFilter(f.id, { operation: e.target.value as WorkspaceSensorFilter['operation'] })}
                                        >
                                            <option value="greater_than">&gt;</option>
                                            <option value="less_than">&lt;</option>
                                            <option value="between">between</option>
                                            <option value="equals">=</option>
                                        </select>
                                        <input
                                            type="number"
                                            className="f4-cond-v"
                                            value={f.value1}
                                            onChange={e => onUpdateFilter(f.id, { value1: e.target.value })}
                                            placeholder="val"
                                        />
                                        {f.operation === 'between' && (
                                            <input
                                                type="number"
                                                className="f4-cond-v"
                                                value={f.value2}
                                                onChange={e => onUpdateFilter(f.id, { value2: e.target.value })}
                                                placeholder="max"
                                            />
                                        )}
                                        <button type="button" className="f4-x" onClick={() => onRemoveFilter(f.id)} title="Remove condition" aria-label="Remove condition">
                                            <X size={13} />
                                        </button>
                                    </div>
                                ))}
                                <div className="f4-acts">
                                    <button type="button" className="f4-btn f4-btn--small" onClick={onAddFilter} disabled={sensors.length === 0}>
                                        <Plus size={11} />Add condition
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    <RuleFormula periods={periods} filters={filters} combine={combine} none={noneConfirmed} />

                    {firstBad >= 0 && (
                        <div data-testid="rc-invalid-reason" className="f4-reason f4-reason--bad">
                            ⚠ Period {firstBad + 1} is invalid — models that follow the workspace can't be built until it's fixed.
                        </div>
                    )}
                    <div className="f4-foot-note">Default for every model — override per model on its own Build page.</div>
                </div>
            )}
        </div>
    );
}
