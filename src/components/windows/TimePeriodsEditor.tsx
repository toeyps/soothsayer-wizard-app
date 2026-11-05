import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { DateTime24Input } from './DateTime24Input';
import type { TimePeriod } from '../../types';
import { PERIOD_COUNTS_IDLE, noRunningRowsNote, trainRowModels, type PeriodCountsState } from '../../utils/periodCounts';
import { NO_TRAIN_PERIOD_EMPTY_TEXT } from '../../utils/runningCondition';
import {
    faultOnSide,
    isRangeFullyCovered,
    mergeOverlapping,
    newPeriodId,
    nextDefaultPeriod,
    sortPeriods,
    validatePeriods,
    type PeriodBaseline,
} from '../../utils/timePeriods';
import { isCompleteDateInput, overlapDays, settleDateInput } from './periodDisplay';

/* TRAIN periods list of the running-condition settings. At least one is required; a row is kept if in ANY period. Blank start only on the first, blank end only on the last. A NEW or CHANGED period entirely outside the data is invalid; one unchanged from `savedPeriods` only warns. A date goes up only when complete (`isCompleteDateInput`); rows sort on blur/Enter and discrete actions; on blur a set bound reverts to its last date (`settleDateInput`). */

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

interface DateFieldProps {
    ariaLabel: string;
    side: 'start' | 'end';
    value: string;
    /** True when the COMMITTED value is blank (shows the open-ended box); the draft is '' mid-edit. */
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
    if (committedBlank && !value.trim()) {
        return (
            <div
                className={`f4-openb${bad ? ' f4-openb--bad' : ''}`}
                data-testid={`period-open-${side}`}
                title={side === 'start' ? 'No start bound — begins at the first row of data' : 'No end bound — runs to the last row of data'}
            >
                <span>{side === 'start' ? 'Start of data' : 'End of data'}</span>
                <button type="button" className="f4-link" disabled={setDateDisabled} onClick={onSetDate} aria-label={`Set ${side} date`}>Set date</button>
            </div>
        );
    }
    return (
        <div className={`f4-dtw${bad ? ' f4-dtw--bad' : ''}`}>
            <DateTime24Input ariaLabel={ariaLabel} invalid={bad} value={value} min={min} max={max} onChange={onType} onCommit={onCommit}>
                {canOpen && (
                    <button
                        type="button"
                        className="f4-link f4-link--muted"
                        data-testid={`period-open-toggle-${side}`}
                        aria-label={side === 'start' ? 'Start from the first row of data' : 'Run to the last row of data'}
                        title={side === 'start' ? 'Start from the first row of data' : 'Run to the last row of data'}
                        onClick={onOpen}
                    >
                        <X size={12} aria-hidden="true" />
                    </button>
                )}
            </DateTime24Input>
        </div>
    );
}

interface TimePeriodsEditorProps {
    periods: TimePeriod[];
    onChange: (next: TimePeriod[]) => void;
    /** True dataset extent (`useDatasetTimeBounds`); drives defaults and min/max. */
    bounds?: PeriodBounds | null;
    /** Per-period running-row counts of the list (`usePeriodCounts`). Omitted =
     *  the rows show their calendar days only. */
    counts?: PeriodCountsState;
    /** Drawn directly under the period rows, above the Add button (the amber
     *  train-period / highlight overlap line). */
    afterRows?: ReactNode;
    /** Row whose date is still being typed ('P1'), or null when every field matches the parent; also null on unmount. */
    onPendingChange?: (name: string | null) => void;
    /** The SAVED list: an unchanged period outside the data only warns; omitted = all periods are new (outside = invalid). */
    savedPeriods?: PeriodBaseline;
}

export default function TimePeriodsEditor({ periods, onChange, bounds, counts = PERIOD_COUNTS_IDLE, afterRows, onPendingChange, savedPeriods }: TimePeriodsEditorProps) {
    const [draft, setDraft] = useState<TimePeriod[]>(periods);
    const [flashId, setFlashId] = useState<string | null>(null);
    const propsKey = JSON.stringify(periods);
    // The list last handed up; when it comes back the draft is already right (a reset would wipe a half-typed field).
    const emittedKey = useRef<string | null>(null);
    useEffect(() => {
        const own = emittedKey.current === propsKey;
        emittedKey.current = null;
        if (!own) setDraft(periods);
    }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!flashId) return;
        const t = setTimeout(() => setFlashId(null), 900);
        return () => clearTimeout(t);
    }, [flashId]);

    const savedById = new Map(periods.map(p => [p.id, p]));
    /** Hands a list up (only when it differs from what the parent has). */
    const emit = (list: TimePeriod[]) => {
        const key = JSON.stringify(list);
        if (key === propsKey) return;
        emittedKey.current = key;
        onChange(list);
    };
    /** A discrete change, or blur / Enter: the list is sorted and handed up. */
    const commit = (list: TimePeriod[], flash?: string) => {
        const sorted = sortPeriods(list);
        setDraft(sorted);
        if (flash) setFlashId(flash);
        emit(sorted);
    };
    /** `list` with each field settled: a set bound that is empty/half-typed returns to its committed date. */
    const settled = (list: TimePeriod[]): TimePeriod[] => list.map(p => {
        const saved = savedById.get(p.id);
        if (!saved) return p;
        const start = settleDateInput(p.start, saved.start);
        const end = settleDateInput(p.end, saved.end);
        return start === p.start && end === p.end ? p : { ...p, start, end };
    });
    /** The field shows what is typed; the parent gets the list only once the date is complete. */
    const typeDate = (i: number, which: 'start' | 'end', v: string) => {
        const next = draft.map((x, j) => (j === i ? { ...x, [which]: v } : x));
        setDraft(next);
        if (!isCompleteDateInput(v)) return;
        emit(next.map((p, j) => {
            const saved = savedById.get(p.id);
            if (!saved) return p;
            // Every field but the one just typed goes up as the parent has it.
            const start = j === i && which === 'start' ? p.start : saved.start;
            const end = j === i && which === 'end' ? p.end : saved.end;
            return start === p.start && end === p.end ? p : { ...p, start, end };
        }));
    };

    // The first row holding a date the parent does not have (still being typed).
    const pendingIndex = draft.findIndex(p => {
        const saved = savedById.get(p.id);
        return !!saved && (saved.start !== p.start || saved.end !== p.end);
    });
    const pendingName = pendingIndex >= 0 ? `P${pendingIndex + 1}` : null;
    const onPendingRef = useRef(onPendingChange);
    onPendingRef.current = onPendingChange;
    useEffect(() => { onPendingRef.current?.(pendingName); }, [pendingName]);
    useEffect(() => () => { onPendingRef.current?.(null); }, []);

    // Judged on screen: a half-typed field counts as the parent's date, so it doesn't flash an error or blank the days.
    const judged = draft.map(p => {
        const saved = savedById.get(p.id);
        if (!saved) return p;
        const start = p.start !== saved.start && !isCompleteDateInput(p.start) ? saved.start : p.start;
        const end = p.end !== saved.end && !isCompleteDateInput(p.end) ? saved.end : p.end;
        return start === p.start && end === p.end ? p : { ...p, start, end };
    });
    // Judged against the loaded data too (the dataset's own bounds, to the second);
    // a period that is exactly as it was saved only warns.
    const statuses = validatePeriods(judged, bounds, savedPeriods);
    const minAttr = toInputValue(bounds?.min);
    const maxAttr = toInputValue(bounds?.max);
    const boundsForCover = minAttr && maxAttr ? { min: minAttr, max: maxAttr } : null;
    const rows = trainRowModels(judged, boundsForCover, counts, statuses.map(s => s.invalid));
    // 'no running rows in P2' is a row note only while other periods have rows; otherwise the red line under the timeline says it.
    const unionHasRows = (counts.train?.union.running_rows ?? 0) > 0;

    const next = judged.length === 0 ? firstDefaultPeriod(bounds) : nextDefaultPeriod(judged, maxAttr ?? null);
    const covered = isRangeFullyCovered(judged, boundsForCover);
    const addDisabled = !next || covered;
    const addTitle = covered
        ? 'The periods already cover the whole dataset'
        : !next ? 'Set an end date on the last period first' : 'Add another train period';

    const addPeriod = () => {
        if (!next) return;
        commit([...settled(draft), next], next.id);
    };

    const field = (i: number, which: 'start' | 'end') => {
        const p = draft[i];
        const st = statuses[i];
        // The date field the fault is about goes red ("Fix P1's end"); both
        // fields for a period that lies outside the data.
        const bad = st.invalid && !!st.fault && faultOnSide(st.fault, which);
        return (
            <DateField
                ariaLabel={`P${i + 1} ${which}`}
                side={which}
                value={p[which]}
                committedBlank={!(periods.find(x => x.id === p.id)?.[which] ?? '').trim()}
                min={minAttr}
                max={maxAttr}
                bad={bad}
                canOpen={which === 'start' ? i === 0 : i === draft.length - 1}
                onType={v => typeDate(i, which, v)}
                onCommit={() => commit(settled(draft))}
                onOpen={() => commit(settled(draft).map((x, j) => (j === i ? { ...x, [which]: '' } : x)))}
                onSetDate={() => {
                    const v = which === 'start' ? minAttr : maxAttr;
                    if (v) commit(settled(draft).map((x, j) => (j === i ? { ...x, [which]: v } : x)), p.id);
                }}
                setDateDisabled={!(which === 'start' ? minAttr : maxAttr)}
            />
        );
    };

    const message = (i: number) => {
        const st = statuses[i];
        const p = judged[i];
        if (st.invalid) {
            return (
                <div role="alert" data-testid={`period-invalid-${i + 1}`} className="rcm-permsg rcm-permsg--bad">
                    {st.rowReason ?? st.reason ?? `P${i + 1} is not valid`}
                </div>
            );
        }
        const notes: ReactNode[] = [];
        if (st.dataNote) {
            // Partly outside the data — or (`outsideData`) a saved period entirely outside it.
            notes.push(<div key="data" data-testid={`period-data-note-${i + 1}`} data-outside={st.outsideData ? 'true' : undefined} className="rcm-permsg rcm-permsg--warn">{st.dataNote}</div>);
        }
        if (rows[i].noRunningRows && unionHasRows) {
            notes.push(<div key="rows" data-testid={`period-no-rows-${i + 1}`} className="rcm-permsg rcm-permsg--warn">{noRunningRowsNote(`P${i + 1}`)}</div>);
        }
        if (st.overlapsPrev) {
            const d = overlapDays(judged[i - 1], p, boundsForCover);
            notes.push(
                <div key="overlap" data-testid={`period-overlap-${i + 1}`} className="rcm-permsg">
                    <span>P{i + 1} overlaps P{i}{d !== null ? ` by ${d} d` : ''} — rows in both are used once.</span>
                    <button
                        type="button"
                        className="f4-link"
                        data-testid={`period-merge-${i + 1}`}
                        onClick={() => {
                            const list = settled(draft);
                            commit([...list.slice(0, i - 1), mergeOverlapping(list[i - 1], list[i]), ...list.slice(i + 1)], list[i - 1].id);
                        }}
                    >
                        Merge into one
                    </button>
                </div>,
            );
        }
        return notes.length ? notes : null;
    };

    return (
        <div data-testid="time-periods-editor" className="rcm-periods">
            {draft.length === 0 && (
                <div data-testid="periods-empty" className="rcx-line rcx-line--warn">{NO_TRAIN_PERIOD_EMPTY_TEXT}</div>
            )}
            {draft.map((p, i) => {
                const st = statuses[i];
                const row = rows[i];
                return (
                    <div
                        key={p.id}
                        data-testid={`period-row-${i + 1}`}
                        data-invalid={st.invalid ? 'true' : undefined}
                        data-outside={st.outsideData ? 'true' : undefined}
                        className={`rcm-per${st.invalid ? ' rcm-per--bad' : st.outsideData ? ' rcm-per--warn' : ''}${flashId === p.id ? ' f4-flash' : ''}`}
                    >
                        <span className="rcm-pn">P{i + 1}</span>
                        <div>{field(i, 'start')}</div>
                        <span className="rcm-arrow" aria-hidden="true">→</span>
                        <div className="f4-dt-end">{field(i, 'end')}</div>
                        <span className="rcm-dur" data-testid={`period-days-${i + 1}`}>
                            {row.daysText}
                            {row.runningText && (
                                <span className={`rcm-run${row.stale ? ' rct-stale' : ''}`} data-testid={`period-running-${i + 1}`} data-stale={row.stale ? 'true' : undefined}> · {row.runningText}</span>
                            )}
                        </span>
                        <button type="button" className="rcm-ib" aria-label={`Remove P${i + 1}`} title="Remove train period" onClick={() => commit(settled(draft).filter((_, j) => j !== i))}>
                            <Trash2 size={14} aria-hidden="true" />
                        </button>
                        {message(i)}
                    </div>
                );
            })}
            {afterRows}
            <button type="button" className="rcm-add" data-testid="period-add" disabled={addDisabled} title={addTitle} onClick={addPeriod}>
                <Plus size={13} aria-hidden="true" />Add train period
            </button>
        </div>
    );
}
