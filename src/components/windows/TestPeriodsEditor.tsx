import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TestPeriod, TimePeriod } from '../../types';
import { PERIOD_COUNTS_IDLE, scoringRowModels, type PeriodCountsState } from '../../utils/periodCounts';
import { noScoringPeriodNote } from '../../utils/runningCondition';
import {
    faultSide,
    newPeriodId,
    periodsOverlap,
    sortPeriods,
    testIncludesTrainNote,
    toScoringPeriod,
    toScoringPeriods,
    trainOverlapDays,
    validateTestPeriods,
} from '../../utils/timePeriods';
import { isCompleteDateInput, settleDateInput } from './periodDisplay';
import type { PeriodBounds } from './TimePeriodsEditor';

/*
 * The "Scoring periods" list ("test periods" until 2026-10-10 — the file, the
 * component and the test ids keep that name, like the storage keys do). Used by
 * the Running condition modal (workspace default) and by a Custom model's own
 * panel in Model settings — the same rows in both.
 *
 * "Just score it" (user decision 2026-10-09, SPEC
 * docs/design/handoff/workbench-redesign/README.md §2): a scoring period is
 * ONLY start → end. The trained model gives a health score for that time and
 * the user reads the chart — there is no Normal / Known problem label, no event
 * time, no verdict and no "From Highlights" here any more.
 *
 * One quiet line per period: S# · start → end · "35 d · 30 d running" · remove
 * (the running days are Rust's per-period count, `counts`; while a new count is
 * on its way the previous number stays, dimmed). A scoring period MAY overlap
 * the train periods: one small grey line under the row says how many days of
 * train time it includes — never a block. An invalid period gets a thin red
 * left edge, a red date field and ONE reason line ("S1 needs an end date").
 *
 * Old workspaces: a period saved before 2026-10-10 may still carry `label` /
 * `eventTime` / `fromHighlight`. They are never shown, and every period this
 * editor hands back is built with `toScoringPeriod` (id / start / end only), so
 * an edit can never carry them on. Merely opening the editor writes nothing
 * (the change check ignores those legacy keys).
 *
 * Typing a date works as in `TimePeriodsEditor` (2026-10-10, review of
 * a4acd7a): a COMPLETE date goes to the parent on change, in the order on
 * screen, so the timeline, the counts and the impact line follow the edit
 * before Apply can be pressed; a half-typed `datetime-local` reports '' — that
 * stays in the field only (`onPendingChange` names the row) and on blur / Enter
 * a date that was set comes back instead of being emptied. The list is put in
 * time order on blur / Enter and on add / remove — never while a date is being
 * typed — so S1, S2 … read left to right on the charts.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const fmtLocal = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** `YYYY-MM-DDTHH:mm` for a `datetime-local` input ('' when blank / unknown). */
export function toInputValue(s: string | null | undefined): string {
    const t = (s ?? '').trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t}T00:00`;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? t.slice(0, 16) : '';
}

const msOf = (s: string): number | null => {
    if (!s) return null;
    const ms = new Date(s).getTime();
    return Number.isNaN(ms) ? null : ms;
};

/** Default range of "Add scoring period": 14 days starting one minute after the
 *  latest end among the train and scoring periods (so it does not touch train
 *  time), else at the dataset start; clamped to the dataset end. Start / end
 *  only — nothing else is ever written on a scoring period. */
export function nextDefaultTestPeriod(train: TimePeriod[], tests: TestPeriod[], bounds: PeriodBounds | null | undefined): TestPeriod {
    const min = toInputValue(bounds?.min);
    const max = toInputValue(bounds?.max);
    const ends = [...train, ...tests].map(p => toInputValue(p.end)).filter(Boolean).sort();
    const lastEnd = ends.length ? ends[ends.length - 1] : '';
    let startMs = lastEnd ? (msOf(lastEnd) ?? 0) + 60_000 : msOf(min);
    const maxMs = msOf(max);
    if (startMs !== null && maxMs !== null && startMs >= maxMs) startMs = msOf(min);
    if (startMs === null) return toScoringPeriod({ id: newPeriodId(), start: '', end: '' });
    let endMs = startMs + 14 * 86_400_000;
    if (maxMs !== null && endMs > maxMs) endMs = maxMs;
    return toScoringPeriod({ id: newPeriodId(), start: fmtLocal(startMs), end: fmtLocal(endMs) });
}

/** Time order, and every period rebuilt as id / start / end only. */
const sortScoring = (list: TestPeriod[]): TestPeriod[] => toScoringPeriods(sortPeriods(list));

/** The one quiet "includes N d of train running time" note of row `i`, or null. */
function overlapNote(train: TimePeriod[], t: TestPeriod, i: number, bounds: { min: string; max: string } | null): string | null {
    if (!train.some(p => periodsOverlap(p, t))) return null;
    const days = trainOverlapDays(train, t, bounds);
    if (days >= 1) return testIncludesTrainNote(i, days);
    return `S${i + 1} includes less than 1 d of train running time — results include rows the model was trained on`;
}

export interface TestPeriodsEditorProps {
    /** The scoring periods (a legacy label / event time on them is ignored). */
    tests: TestPeriod[];
    /** The train periods next to them (for the overlap note and the Add default). */
    train: TimePeriod[];
    /** Always called with id / start / end only periods, in time order. */
    onChange: (next: TestPeriod[]) => void;
    /** True dataset extent (`useDatasetTimeBounds`): defaults, min/max, day counts. */
    bounds?: PeriodBounds | null;
    /** What the surrounding form does, for the empty note ("you can train and
     *  apply now" in the Running-condition settings, "… and save now" in a
     *  Custom model's own panel). Default `'apply'`. */
    blocks?: 'apply' | 'save';
    /** Per-period running-row counts of the list (`usePeriodCounts`). Omitted =
     *  the rows show their calendar days only. */
    counts?: PeriodCountsState;
    /** The row whose date is still being typed ("S1"), or null once every field
     *  holds what the parent has. Called when that changes, and with null on
     *  unmount. */
    onPendingChange?: (name: string | null) => void;
}

export default function TestPeriodsEditor({ tests, train, onChange, bounds, blocks = 'apply', counts = PERIOD_COUNTS_IDLE, onPendingChange }: TestPeriodsEditorProps) {
    // The draft and the change check both work on the start / end only form, so a
    // legacy label on the incoming periods is neither drawn nor read as a change.
    const saved = toScoringPeriods(tests);
    const propsKey = JSON.stringify(saved);
    const [draft, setDraft] = useState<TestPeriod[]>(() => toScoringPeriods(tests));
    // The list this editor last handed up: when exactly that comes back the local
    // draft is already right (and may hold a half-typed field a reset would wipe).
    const emittedKey = useRef<string | null>(null);
    useEffect(() => {
        const own = emittedKey.current === propsKey;
        emittedKey.current = null;
        if (!own) setDraft(toScoringPeriods(tests));
    }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const minAttr = toInputValue(bounds?.min) || undefined;
    const maxAttr = toInputValue(bounds?.max) || undefined;
    const boundsForDays = minAttr && maxAttr ? { min: minAttr, max: maxAttr } : null;

    const savedById = new Map(saved.map(t => [t.id, t]));
    /** Hands a list up (only when it differs from what the parent has). */
    const emit = (list: TestPeriod[]) => {
        const key = JSON.stringify(list);
        if (key === propsKey) return;
        emittedKey.current = key;
        onChange(list);
    };
    /** A discrete change, or blur / Enter: the list is sorted and handed up. */
    const commit = (list: TestPeriod[]) => {
        const sorted = sortScoring(list);
        setDraft(sorted);
        emit(sorted);
    };
    /** `list` with every field as it settles (`settleDateInput`): a date that was
     *  set and is empty / half-typed in the field goes back to its committed value. */
    const settled = (list: TestPeriod[]): TestPeriod[] => list.map(t => {
        const was = savedById.get(t.id);
        return was ? toScoringPeriod({ id: t.id, start: settleDateInput(t.start, was.start), end: settleDateInput(t.end, was.end) }) : t;
    });
    /** A date field changed. The field always shows what is typed; the parent gets
     *  the list — in the order on screen — only once the date is complete, and
     *  never a half-typed value of another field. */
    const type = (i: number, which: 'start' | 'end', v: string) => {
        const next = draft.map((t, j) => (j === i ? toScoringPeriod({ ...t, [which]: v }) : t));
        setDraft(next);
        if (!isCompleteDateInput(v)) return;
        emit(next.map((t, j) => {
            const was = savedById.get(t.id);
            if (!was) return t;
            // Every field but the one just typed goes up as the parent has it.
            return toScoringPeriod({
                id: t.id,
                start: j === i && which === 'start' ? t.start : was.start,
                end: j === i && which === 'end' ? t.end : was.end,
            });
        }));
    };

    // The first row holding a date the parent does not have (still being typed).
    const pendingIndex = draft.findIndex(t => {
        const was = savedById.get(t.id);
        return !!was && (was.start !== t.start || was.end !== t.end);
    });
    const pendingName = pendingIndex >= 0 ? `S${pendingIndex + 1}` : null;
    const onPendingRef = useRef(onPendingChange);
    onPendingRef.current = onPendingChange;
    useEffect(() => { onPendingRef.current?.(pendingName); }, [pendingName]);
    useEffect(() => () => { onPendingRef.current?.(null); }, []);

    // The list as it is JUDGED on screen (validity, day counts, the train-time
    // note): a field still being typed counts as the date the parent has, so a
    // half-typed date does not flash "S1 needs an end date" (it never reaches the
    // parent, and a blur puts the date back). The field shows what is typed.
    const judged = draft.map(t => {
        const was = savedById.get(t.id);
        if (!was) return t;
        const start = t.start !== was.start && !isCompleteDateInput(t.start) ? was.start : t.start;
        const end = t.end !== was.end && !isCompleteDateInput(t.end) ? was.end : t.end;
        return start === t.start && end === t.end ? t : toScoringPeriod({ id: t.id, start, end });
    });
    const statuses = validateTestPeriods(judged);
    const rows = scoringRowModels(judged, boundsForDays, counts);

    const dateInput = (i: number, which: 'start' | 'end', label: string, bad = false) => (
        <div className={`f4-dtw${bad ? ' f4-dtw--bad' : ''}`}>
            <input
                type="datetime-local"
                aria-label={label}
                aria-invalid={bad || undefined}
                value={toInputValue(draft[i][which])}
                min={minAttr}
                max={maxAttr}
                onChange={e => type(i, which, e.target.value)}
                onBlur={() => commit(settled(draft))}
                onKeyDown={e => { if (e.key === 'Enter') commit(settled(draft)); }}
            />
        </div>
    );

    return (
        <div className="tpe-periods" data-testid="test-periods-editor">
            {draft.length === 0 && (
                <div className="rcx-line" data-testid="tests-empty">{noScoringPeriodNote(blocks)}</div>
            )}
            {draft.map((t, i) => {
                const n = i + 1;
                const st = statuses[i];
                const row = rows[i];
                const note = st.invalid ? null : overlapNote(train, judged[i], i, boundsForDays);
                // The date field the fault is about goes red.
                const badSide = st.invalid && st.fault ? faultSide(st.fault) : null;
                return (
                    <div key={t.id} className={`rcm-per${st.invalid ? ' rcm-per--bad' : ''}`} data-testid={`test-row-${n}`} data-invalid={st.invalid ? 'true' : undefined}>
                        <span className="rcm-pn tpe-pn">S{n}</span>
                        {dateInput(i, 'start', `Scoring period ${n} start`, badSide === 'start')}
                        <span className="rcm-arrow" aria-hidden="true">→</span>
                        <div className="f4-dt-end">{dateInput(i, 'end', `Scoring period ${n} end`, badSide === 'end')}</div>
                        <span className="rcm-dur" data-testid={`test-days-${n}`}>
                            {row.daysText}
                            {row.runningText && (
                                <span className={`rcm-run${row.stale ? ' rct-stale' : ''}`} data-testid={`test-running-${n}`} data-stale={row.stale ? 'true' : undefined}> · {row.runningText}</span>
                            )}
                        </span>
                        <button type="button" className="rcm-ib" aria-label={`Remove scoring period ${n}`} title="Remove scoring period" onClick={() => commit(settled(draft).filter((_, j) => j !== i))}>
                            <Trash2 size={14} aria-hidden="true" />
                        </button>
                        {st.invalid && (
                            <div role="alert" className="rcm-permsg rcm-permsg--bad" data-testid={`test-invalid-${n}`}>
                                {st.rowReason ?? st.reason ?? `S${n} is not valid`}
                            </div>
                        )}
                        {note && <div className="rcm-permsg" data-testid={`test-overlap-${n}`}>{note}</div>}
                    </div>
                );
            })}
            <button type="button" className="rcm-add" data-testid="test-add" onClick={() => { const list = settled(draft); commit([...list, nextDefaultTestPeriod(train, list, bounds)]); }}>
                <Plus size={13} aria-hidden="true" />Add scoring period
            </button>
        </div>
    );
}
