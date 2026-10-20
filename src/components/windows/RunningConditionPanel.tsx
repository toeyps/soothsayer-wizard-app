import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import type { TestPeriod, TimeHighlight, TimePeriod, WorkspaceSensorFilter } from '../../types';
import { PERIOD_COUNTS_IDLE, type PeriodCountsState } from '../../utils/periodCounts';
import { CUSTOM_PANEL_FOOTNOTE, isCompleteCondition } from '../../utils/runningCondition';
import { validatePeriods, type PeriodBaseline } from '../../utils/timePeriods';
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
 *   Train periods              one eyebrow line · one quiet line per period
 *   Scoring periods            one eyebrow line · one quiet line per period
 *   When the plant is running  one eyebrow line · one radio row · one-line conditions
 *
 * No right-hand preview column and no callout boxes. No number of data rows
 * either (user decision 2026-10-14): the counts are shown as running DAYS — in
 * the caption and at the end of each period row — never as rows or a percentage. Presentation only: every value and handler arrives through
 * props, and nothing here writes anything.
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

const MODES = [
    ['condition', 'Only when running', 'keep rows that meet a condition'],
    ['none', 'Use all rows', 'idle and shutdown time included'],
] as const;

export interface RunningConditionPanelProps {
    /** `workspace` (default): the modal's draft. `custom`: one model's own
     *  running condition — different test ids on the root and the sections,
     *  "save" wording, and the footnote at the end. */
    scope?: 'workspace' | 'custom';
    /** Workspace scope only: the export's "Machine is running when … is above …"
     *  line, shown at the end of the conditions section (the owner decides when). */
    runningStatusSlot?: ReactNode;
    /** The running condition (as drafted) is configured. */
    configured: boolean;
    /** TRAIN periods. */
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
    scope = 'workspace', configured, periods, onPeriodsChange, bounds, filters, combine, noneConfirmed,
    onNoneChange, onCombineChange, onAddFilter, onUpdateFilter, onRemoveFilter, sensors, getComponent, getUnit,
    counts = PERIOD_COUNTS_IDLE, testPeriods, onTestPeriodsChange, highlights, onPendingDate, savedPeriods, savedTestPeriods, runningStatusSlot,
}: RunningConditionPanelProps) {
    const custom = scope === 'custom';
    // "Only when running" without a complete condition: the count would be of
    // EVERY row (no condition is sent), which is not what will be trained on once
    // the condition is set — so no running days on the rows, and the caption
    // claims no running time either.
    const rowCounts = configured ? counts : PERIOD_COUNTS_IDLE;
    const validCount = validatePeriods(periods).filter(s => !s.invalid).length;
    const headers = sensors.length ? sensors : null;
    // Test ids of the two uses differ, so both can be on screen at once (the
    // workspace modal over a Custom model's open settings).
    const id = (workspace: string, own: string) => (custom ? own : workspace);

    const setMode = (none: boolean) => { if (none !== noneConfirmed) onNoneChange(none); };
    /** A radio row: the arrow keys move the choice, like a native radio group. */
    const onModeKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const next = !noneConfirmed;
        setMode(next);
        const el = e.currentTarget.querySelector<HTMLElement>(`[data-mode="${next ? 'none' : 'condition'}"]`);
        el?.focus();
    };

    return (
        <div data-testid={id('rc-panel', 'custom-rc-panel')} className={`rcm-body${custom ? ' rcm-body--own' : ''}`}>
            <RunningConditionTimeline periods={periods} tests={testPeriods} bounds={bounds} counts={counts} configured={configured} usesAllRows={noneConfirmed} savedPeriods={savedPeriods} savedTests={savedTestPeriods} />

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
                    <b>When the plant is running</b>
                    <span>rows outside the condition are not used for training or scoring. Required.</span>
                </div>

                {/* Value conditions vs. an explicit "Use all rows" — exactly one is
                    active; a running condition is REQUIRED before any model can
                    train. "Use all rows" clears nothing stored, it just stops the
                    saved conditions applying. */}
                <div role="radiogroup" aria-label="Condition mode" className="rcx-mode" onKeyDown={onModeKey}>
                    {MODES.map(([mode, title, hint]) => {
                        const active = (mode === 'none') === noneConfirmed;
                        return (
                            <button
                                key={mode}
                                type="button"
                                role="radio"
                                data-testid={`rc-mode-${mode}`}
                                data-mode={mode}
                                className={`rcx-radio${active ? ' rcx-radio--on' : ''}`}
                                aria-checked={active}
                                tabIndex={active ? 0 : -1}
                                onClick={() => setMode(mode === 'none')}
                            >
                                <span className="rcm-rd" aria-hidden="true" />
                                <b>{title}</b>
                                <small>· {hint}</small>
                            </button>
                        );
                    })}
                </div>

                {noneConfirmed ? (
                    <div data-testid="rc-none-note" className="rcx-line">
                        Every row inside the train periods is used, idle time included.{' '}
                        {validCount > 0
                            ? `The ${validCount} train period${validCount > 1 ? 's' : ''} above still limit${validCount > 1 ? '' : 's'} the time.`
                            : 'There is no train period yet — add one above.'}
                        {filters.length > 0 && ' Your saved conditions are kept but not applied.'}
                    </div>
                ) : (
                    <>
                        <div className="rcm-conds">
                            {filters.length === 0 && (
                                <div className="rcx-line" data-testid="rc-no-conditions">
                                    Add a condition that tells running from idle — for example <b>active power &gt; a level</b>.
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
                                        {/* ONE line: [sensor] [> < ↔ =] [value unit] [✕]. No component chip
                                            (the picker's rows show the component); the sensor trigger is
                                            capped (~360 px) so the value input never clips. */}
                                        <div
                                            className={`rcm-cond${f.operation === 'between' ? ' rcm-cond--between' : ''}${incomplete ? ' rcm-cond--incomplete' : ''}`}
                                            data-testid={`rc-cond-${i + 1}`}
                                            data-incomplete={incomplete ? 'true' : undefined}
                                        >
                                            <div className="rcm-cond-s">
                                                <SensorPickerModal
                                                    sensors={sensors}
                                                    getComponent={getComponent}
                                                    single
                                                    value={f.sensor}
                                                    onSelect={sensor => onUpdateFilter(f.id, { sensor })}
                                                    noun="sensor"
                                                />
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
                {!configured && (
                    <div data-testid="rc-unset-warning" className="rcx-line rcx-line--warn">
                        Choose “Only when running” with a condition, or “Use all rows”, before training a model.
                    </div>
                )}
                {!custom && runningStatusSlot}
            </section>

            {custom && <div className="rcx-footnote" data-testid="custom-rc-footnote">{CUSTOM_PANEL_FOOTNOTE}</div>}
        </div>
    );
}
