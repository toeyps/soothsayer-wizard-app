import { useEffect, useRef, useState } from 'react';
import { Calendar, X } from 'lucide-react';
import type { TimePeriod } from '../../types';
import {
    isRangeFullyCovered,
    mergeOverlapping,
    newPeriodId,
    nextDefaultPeriod,
    sortPeriods,
    validatePeriods,
} from '../../utils/timePeriods';
import { boundsMs, DAY_MS, formatDate, formatPeriod, overlapDays, periodDays } from './periodDisplay';
import { PeriodCoverageBar } from './RunningConditionParts';

/*
 * Training time periods (Feature 4-C). One list, shared by the Overview's
 * Running Condition panel (workspace default) and the PM page's Custom
 * section; `PeriodReadOnlyList` is the read-only view for the PM Workspace mode.
 *
 * Semantics: empty list = no time limit; a row is kept if it falls in ANY
 * period. A blank start is only allowed on the first period ("Start of data"),
 * a blank end only on the last ("End of data"). Overlap is a warning with a
 * "Merge into one" fix, NOT a block; a reversed/unparseable period is invalid
 * and blocks Build (see `getBuildBlockReason`).
 *
 * Edits stay in a local draft and are committed (sorted) on blur / Enter, never
 * per keystroke, so rows don't jump around while a date is being typed.
 *
 * Visual spec: the approved time-ranges.html mockup - wide rows on the
 * Overview, collapsible compact rows in the 300 px Build-page sidebar.
 */

export interface PeriodBounds {
    min: string | null;
    max: string | null;
}

/** `YYYY-MM-DDTHH:mm` for a `datetime-local` min/max attribute, else undefined. */
function toInputValue(s: string | null | undefined): string | undefined {
    const t = (s ?? '').trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t}T00:00`;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? t.slice(0, 16) : undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmtLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** First period of an empty list: from the data's start to the end of that month. */
function firstDefaultPeriod(bounds: PeriodBounds | null | undefined): TimePeriod {
    const min = toInputValue(bounds?.min);
    if (!min) return { id: newPeriodId(), start: '', end: '' };
    const d = new Date(min);
    let end = fmtLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59));
    const max = toInputValue(bounds?.max);
    if (max && end > max) end = max;
    return { id: newPeriodId(), start: min, end };
}

/** Read-only list (PM page, Workspace mode): first 3 periods, "+N more" toggle. */
export function PeriodReadOnlyList({ periods, bounds }: { periods: TimePeriod[]; bounds?: PeriodBounds | null }) {
    const [all, setAll] = useState(false);
    const status = validatePeriods(periods);
    const ok = periods.filter((_, i) => !status[i].invalid);
    if (ok.length === 0) {
        return (
            <div data-testid="period-chips-empty" className="f4-note" style={{ fontStyle: 'italic', opacity: 0.75, fontSize: '11px' }}>
                No limit set — full dataset
            </div>
        );
    }
    const shown = all ? ok : ok.slice(0, 3);
    return (
        <>
            <PeriodCoverageBar periods={periods} bounds={bounds} />
            <div data-testid="period-chips" className="f4-rolist">
                {shown.map(p => {
                    const d = periodDays(p, bounds);
                    return (
                        <div key={p.id} data-testid="period-chip" className="f4-roline">
                            <span className="f4-dot" />
                            <span title={formatPeriod(p)}>{formatPeriod(p)}</span>
                            {d !== null && <span className="f4-roline-d">{d} d</span>}
                        </div>
                    );
                })}
                {ok.length > 3 && (
                    <button type="button" className="f4-link" style={{ justifySelf: 'start', paddingLeft: 0 }} data-testid="period-chips-toggle" onClick={() => setAll(v => !v)}>
                        {all ? 'Show fewer' : `+${ok.length - 3} more`}
                    </button>
                )}
            </div>
        </>
    );
}

interface DateFieldProps {
    ariaLabel: string;
    side: 'start' | 'end';
    value: string;
    /** The COMMITTED value is blank -> show the open-ended box. Driven by the
     *  committed value, not the draft: an unfinished datetime-local reports ''
     *  while typing and must not swap the input away mid-edit. */
    committedBlank: boolean;
    min?: string;
    max?: string;
    bad?: boolean;
    /** May be switched to "open" (start of first / end of last period). */
    canOpen: boolean;
    onType: (v: string) => void;
    onCommit: () => void;
    onOpen: () => void;
    onSetDate: () => void;
    setDateDisabled: boolean;
}

function DateField({ ariaLabel, side, value, committedBlank, min, max, bad, canOpen, onType, onCommit, onOpen, onSetDate, setDateDisabled }: DateFieldProps) {
    const ref = useRef<HTMLInputElement>(null);
    if (committedBlank && !value.trim()) {
        return (
            <div
                className="f4-openb"
                data-testid={`period-open-${side}`}
                title={side === 'start' ? 'No start bound — begins at the first row of data' : 'No end bound — runs to the last row of data'}
            >
                <span>{side === 'start' ? '⟵ Start of data' : 'End of data ⟶'}</span>
                <button type="button" className="f4-link" disabled={setDateDisabled} onClick={onSetDate} aria-label={`Set ${side} date`}>Set date</button>
            </div>
        );
    }
    return (
        <div className={`f4-dtw${bad ? ' f4-dtw--bad' : ''}`}>
            <input
                ref={ref}
                type="datetime-local"
                aria-label={ariaLabel}
                value={value}
                min={min}
                max={max}
                onChange={e => onType(e.target.value)}
                onBlur={onCommit}
                onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
            />
            {canOpen && (
                <button
                    type="button"
                    className="f4-link f4-link--muted"
                    data-testid={`period-open-toggle-${side}`}
                    aria-label={side === 'start' ? 'Start from the first row of data' : 'Run to the last row of data'}
                    title={side === 'start' ? 'Start from the first row of data' : 'Run to the last row of data'}
                    onClick={onOpen}
                >
                    {side === 'start' ? '⟵' : '⟶'}
                </button>
            )}
            <button
                type="button"
                className="f4-dtw-cal"
                aria-label="Open date picker"
                onClick={() => { try { ref.current?.showPicker(); } catch { ref.current?.focus(); } }}
            >
                <Calendar size={14} />
            </button>
        </div>
    );
}

interface TimePeriodsEditorProps {
    periods: TimePeriod[];
    onChange: (next: TimePeriod[]) => void;
    /** True dataset extent (`useDatasetTimeBounds`); drives defaults and min/max. */
    bounds?: PeriodBounds | null;
    compact?: boolean;
}

export default function TimePeriodsEditor({ periods, onChange, bounds, compact = false }: TimePeriodsEditorProps) {
    const [draft, setDraft] = useState<TimePeriod[]>(periods);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [flashId, setFlashId] = useState<string | null>(null);
    const propsKey = JSON.stringify(periods);
    useEffect(() => { setDraft(periods); }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!flashId) return;
        const t = setTimeout(() => setFlashId(null), 900);
        return () => clearTimeout(t);
    }, [flashId]);

    const commit = (list: TimePeriod[], flash?: string) => {
        const sorted = sortPeriods(list);
        setDraft(sorted);
        if (flash) setFlashId(flash);
        if (JSON.stringify(sorted) !== propsKey) onChange(sorted);
    };

    const statuses = validatePeriods(draft);
    const minAttr = toInputValue(bounds?.min);
    const maxAttr = toInputValue(bounds?.max);
    const boundsForCover = minAttr && maxAttr ? { min: minAttr, max: maxAttr } : null;
    const bms = boundsMs(boundsForCover);
    const totalDays = bms ? Math.round((bms.t1 - bms.t0) / DAY_MS) : null;

    const next = draft.length === 0 ? firstDefaultPeriod(bounds) : nextDefaultPeriod(draft, maxAttr ?? null);
    const covered = isRangeFullyCovered(draft, boundsForCover);
    const addDisabled = !next || covered;
    const addTitle = covered
        ? 'The periods already cover the whole dataset'
        : !next ? 'Set an end date on the last period first' : 'Add another training period';

    const patch = (i: number, p: Partial<TimePeriod>) =>
        setDraft(prev => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));

    const addPeriod = () => {
        if (!next) return;
        commit([...draft, next], next.id);
        if (compact) setExpandedId(next.id);
    };

    const field = (i: number, which: 'start' | 'end') => {
        const p = draft[i];
        const st = statuses[i];
        const reversedEnd = which === 'end' && st.invalid && (st.reason ?? '').includes('ends before');
        return (
            <DateField
                ariaLabel={`Period ${i + 1} ${which}`}
                side={which}
                value={p[which]}
                committedBlank={!(periods.find(x => x.id === p.id)?.[which] ?? '').trim()}
                min={minAttr}
                max={maxAttr}
                bad={reversedEnd}
                canOpen={which === 'start' ? i === 0 : i === draft.length - 1}
                onType={v => patch(i, { [which]: v })}
                onCommit={() => commit(draft)}
                onOpen={() => commit(draft.map((x, j) => (j === i ? { ...x, [which]: '' } : x)))}
                onSetDate={() => {
                    const v = which === 'start' ? minAttr : maxAttr;
                    if (v) commit(draft.map((x, j) => (j === i ? { ...x, [which]: v } : x)), p.id);
                }}
                setDateDisabled={!(which === 'start' ? minAttr : maxAttr)}
            />
        );
    };

    const message = (i: number, cls: 'pmsg' | 'cmsg') => {
        const st = statuses[i];
        const p = draft[i];
        if (st.invalid) {
            const reversed = (st.reason ?? '').includes('ends before');
            return (
                <div role="alert" data-testid={`period-invalid-${i + 1}`} className={`f4-${cls} f4-${cls}--bad`}>
                    {reversed
                        ? `End is before start — pick an end after ${formatDate(p.start)}. This period is ignored and building is blocked until fixed.`
                        : `${st.reason} This period is ignored and building is blocked until fixed.`}
                </div>
            );
        }
        if (st.overlapsPrev) {
            const d = overlapDays(draft[i - 1], p, boundsForCover);
            return (
                <div data-testid={`period-overlap-${i + 1}`} className={`f4-${cls} f4-${cls}--ovl`}>
                    <span>Overlaps period {i} {d !== null ? `by ${d} d ` : ''}— rows in both are used once.</span>
                    <button
                        type="button"
                        className="f4-link"
                        data-testid={`period-merge-${i + 1}`}
                        onClick={() => commit([...draft.slice(0, i - 1), mergeOverlapping(draft[i - 1], p), ...draft.slice(i + 1)], draft[i - 1].id)}
                    >
                        Merge into one
                    </button>
                </div>
            );
        }
        return null;
    };

    const rowClass = (i: number) => (statuses[i].invalid ? 'bad' : statuses[i].overlapsPrev ? 'ovl' : '');

    return (
        <div data-testid="time-periods-editor" style={{ display: 'grid', gap: compact ? '6px' : '8px' }}>
            {draft.length === 0 ? (
                <div data-testid="periods-empty" className="f4-empty" style={compact ? { padding: '8px 9px' } : undefined}>
                    <span>
                        <b>No limit</b> — {compact ? 'full dataset' : `the full dataset${totalDays !== null ? ` (${totalDays} days)` : ''} is used.`}
                    </span>
                    <button type="button" className="f4-btn f4-btn--small" data-testid="period-add" disabled={addDisabled} title={addTitle} onClick={addPeriod}>
                        + Add period
                    </button>
                </div>
            ) : (
                <>
                    <PeriodCoverageBar periods={draft} bounds={boundsForCover} />
                    <div className="f4-plist" style={compact ? { gap: '4px' } : undefined}>
                        {draft.map((p, i) => {
                            const st = statuses[i];
                            const cls = rowClass(i);
                            const days = periodDays(p, boundsForCover);
                            if (!compact) {
                                return (
                                    <div key={p.id} data-testid={`period-row-${i + 1}`} className={`f4-prow${cls ? ` f4-prow--${cls}` : ''}${flashId === p.id ? ' f4-flash' : ''}`}>
                                        <span className="f4-pnum">{i + 1}</span>
                                        <div>{field(i, 'start')}</div>
                                        <span className="f4-arrow">→</span>
                                        <div className="f4-dt-end">{field(i, 'end')}</div>
                                        <span className="f4-dur">{st.invalid || days === null ? '—' : `${days} d`}</span>
                                        <button type="button" className="f4-x" aria-label={`Remove period ${i + 1}`} onClick={() => commit(draft.filter((_, j) => j !== i))}>
                                            <X size={13} />
                                        </button>
                                        {message(i, 'pmsg')}
                                    </div>
                                );
                            }
                            const open = expandedId === p.id;
                            return (
                                <div key={p.id} data-testid={`period-row-${i + 1}`} className={`f4-crow${cls ? ` f4-crow--${cls}` : ''}${flashId === p.id ? ' f4-flash' : ''}`}>
                                    <button type="button" className="f4-crow-h" aria-expanded={open} data-testid={`period-toggle-${i + 1}`} onClick={() => setExpandedId(open ? null : p.id)}>
                                        <span className="f4-crow-chev">{open ? '▾' : '▸'}</span>
                                        <span className="f4-dot" />
                                        <span className="f4-crow-lbl" title={formatPeriod(p)}>{st.invalid ? 'Invalid period' : formatPeriod(p)}</span>
                                        <span className="f4-count">{st.invalid || days === null ? '—' : `${days} d`}</span>
                                    </button>
                                    {open && (
                                        <div className="f4-crow-b">
                                            <div><label>From</label>{field(i, 'start')}</div>
                                            <div><label>To</label>{field(i, 'end')}</div>
                                            <div className="f4-acts f4-acts--between">
                                                <button type="button" className="f4-link f4-link--muted" aria-label={`Remove period ${i + 1}`} onClick={() => commit(draft.filter((_, j) => j !== i))}>Remove period</button>
                                                <button type="button" className="f4-link" onClick={() => setExpandedId(null)}>Done</button>
                                            </div>
                                        </div>
                                    )}
                                    {message(i, 'cmsg')}
                                </div>
                            );
                        })}
                    </div>
                    <div className="f4-acts">
                        <button type="button" className="f4-btn f4-btn--small" data-testid="period-add" disabled={addDisabled} title={addTitle} onClick={addPeriod}>
                            + Add period
                        </button>
                        <span className="f4-note f4-note--faint">
                            {covered ? 'Periods already cover all data' : 'new period starts after the last one'}
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}
