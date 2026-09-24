import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { TimePeriod } from '../../types';
import {
    isRangeFullyCovered,
    mergeOverlapping,
    newPeriodId,
    nextDefaultPeriod,
    periodChipLabel,
    sortPeriods,
    validatePeriods,
} from '../../utils/timePeriods';

/*
 * Training time periods (Feature 4-C). One list, shared by the Overview's
 * Running Condition panel (workspace default) and the PM page's Custom
 * section; `TimePeriodChips` is the read-only view for the PM Workspace mode.
 *
 * Semantics: empty list = no time limit; a row is kept if it falls in ANY
 * period. A blank start is only allowed on the first period ("Start of data"),
 * a blank end only on the last ("End of data"). Overlap is a warning with a
 * "Merge into one" fix, NOT a block; a reversed/unparseable period is invalid
 * and blocks Build (see `getBuildBlockReason`).
 *
 * Edits stay in a local draft and are committed (sorted) on blur / Enter, never
 * per keystroke, so rows don't jump around while a date is being typed.
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

/** Read-only chips (PM page, Workspace mode). */
export function TimePeriodChips({ periods }: { periods: TimePeriod[] }) {
    if (periods.length === 0) {
        return (
            <div data-testid="period-chips-empty" style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', opacity: 0.65, fontStyle: 'italic' }}>
                Time: no limit set — full dataset
            </div>
        );
    }
    return (
        <div data-testid="period-chips" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                Time: {periods.length} period{periods.length !== 1 ? 's' : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {periods.map(p => (
                    <span key={p.id} className="pm-count-pill" data-testid="period-chip" style={{ padding: '0.2rem 0.45rem', fontSize: '0.66rem', fontWeight: 500 }}>
                        {periodChipLabel(p)}
                    </span>
                ))}
            </div>
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
    const propsKey = JSON.stringify(periods);
    useEffect(() => { setDraft(periods); }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const commit = (list: TimePeriod[]) => {
        const sorted = sortPeriods(list);
        setDraft(sorted);
        if (JSON.stringify(sorted) !== propsKey) onChange(sorted);
    };

    const statuses = validatePeriods(draft);
    const minAttr = toInputValue(bounds?.min);
    const maxAttr = toInputValue(bounds?.max);
    const boundsForCover = minAttr && maxAttr ? { min: minAttr, max: maxAttr } : null;

    const next = draft.length === 0 ? firstDefaultPeriod(bounds) : nextDefaultPeriod(draft, maxAttr ?? null);
    const covered = isRangeFullyCovered(draft, boundsForCover);
    const addDisabled = !next || covered;
    const addTitle = covered
        ? 'The periods already cover the whole dataset'
        : !next ? 'Set an end date on the last period first' : 'Add another training period';

    const patch = (i: number, p: Partial<TimePeriod>) =>
        setDraft(prev => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));

    const field = (i: number, which: 'start' | 'end') => {
        const p = draft[i];
        const value = p[which];
        const isOpen = !value.trim();
        return (
            <div style={{ flex: 1, minWidth: compact ? '120px' : '150px' }}>
                <input
                    type="datetime-local"
                    aria-label={`Period ${i + 1} ${which}`}
                    value={value}
                    min={minAttr}
                    max={maxAttr}
                    onChange={e => patch(i, { [which]: e.target.value })}
                    onBlur={() => commit(draft)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(draft); }}
                    style={{ width: '100%' }}
                />
                {isOpen && (
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-faint)', fontStyle: 'italic', marginTop: '2px' }}>
                        {which === 'start' ? 'Start of data' : 'End of data'}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div data-testid="time-periods-editor" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {draft.length === 0 && (
                <div data-testid="periods-empty" style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', opacity: 0.7, fontStyle: 'italic' }}>
                    No time limit — the whole dataset is used. Add a period to train on only part of it.
                </div>
            )}
            {draft.map((p, i) => {
                const st = statuses[i];
                return (
                    <div key={p.id} data-testid={`period-row-${i + 1}`} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        {st.overlapsPrev && (
                            <div data-testid={`period-overlap-${i + 1}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '0.64rem', color: 'var(--warn, #d9a441)' }}>
                                <span>Period {i + 1} overlaps period {i}.</span>
                                <button
                                    type="button"
                                    className="text-btn"
                                    data-testid={`period-merge-${i + 1}`}
                                    onClick={() => commit([...draft.slice(0, i - 1), mergeOverlapping(draft[i - 1], p), ...draft.slice(i + 1)])}
                                >
                                    Merge into one
                                </button>
                            </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-faint)', minWidth: '14px', paddingTop: '0.4rem' }}>{i + 1}</span>
                            {field(i, 'start')}
                            <span style={{ paddingTop: '0.35rem', color: 'var(--text-faint)' }}>–</span>
                            {field(i, 'end')}
                            <button
                                type="button"
                                aria-label={`Remove period ${i + 1}`}
                                onClick={() => commit(draft.filter((_, j) => j !== i))}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', paddingTop: '0.3rem' }}
                            >
                                <X size={13} />
                            </button>
                        </div>
                        {st.invalid && (
                            <div role="alert" data-testid={`period-invalid-${i + 1}`} style={{ fontSize: '0.64rem', color: 'var(--danger, #f43f5e)' }}>
                                {st.reason}
                            </div>
                        )}
                    </div>
                );
            })}
            <div>
                <button
                    type="button"
                    className="text-btn"
                    data-testid="period-add"
                    disabled={addDisabled}
                    title={addTitle}
                    onClick={() => next && commit([...draft, next])}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                    <Plus size={12} /> Add period
                </button>
            </div>
        </div>
    );
}
