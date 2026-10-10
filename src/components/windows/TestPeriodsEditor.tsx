import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TestPeriod, TimePeriod } from '../../types';
import {
    newPeriodId,
    periodsOverlap,
    sortPeriods,
    testIncludesTrainNote,
    toScoringPeriod,
    toScoringPeriods,
    trainOverlapDays,
    validateTestPeriods,
} from '../../utils/timePeriods';
import { periodDays } from './periodDisplay';
import type { PeriodBounds } from './TimePeriodsEditor';

/*
 * The "Scoring periods" list ("test periods" until 2026-10-10 — the file, the
 * component and the test ids keep that name, like the storage keys do). Used by
 * the Running condition modal (workspace default) and by a Custom model's own
 * Model settings (`compact`).
 *
 * "Just score it" (user decision 2026-10-09, SPEC
 * docs/design/handoff/workbench-redesign/README.md §2): a scoring period is
 * ONLY start → end. The trained model gives a health score for that time and
 * the user reads the chart — there is no Normal / Known problem label, no event
 * time, no verdict and no "From Highlights" here any more.
 *
 * One row per period: S# · start → end · days · remove. A scoring period MAY
 * overlap the train periods: one quiet grey note says how many days of train
 * time it includes — never a block.
 *
 * Old workspaces: a period saved before 2026-10-10 may still carry `label` /
 * `eventTime` / `fromHighlight`. They are never shown, and every period this
 * editor hands back is built with `toScoringPeriod` (id / start / end only), so
 * an edit can never carry them on. Merely opening the editor writes nothing
 * (the change check ignores those legacy keys).
 *
 * Dates are edited in a local draft and committed on blur / Enter (never per
 * keystroke — a half-typed `datetime-local` reports '' and must not reset the
 * field), same as `TimePeriodsEditor`. The list is kept in time order, so S1,
 * S2 … read left to right on the charts.
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
    if (days >= 1) return `${testIncludesTrainNote(i, days)}.`;
    return `S${i + 1} includes less than 1 d of train running time — results include rows the model was trained on.`;
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
    /** Narrow variant for a Custom model's Model settings. */
    compact?: boolean;
    /** What an invalid row blocks, for its message ("Fix it to apply" in the
     *  Running condition modal, "Fix it to save" in a Custom model's settings,
     *  where it blocks Save changes). Default `'apply'`. */
    blocks?: 'apply' | 'save';
}

export default function TestPeriodsEditor({ tests, train, onChange, bounds, compact = false, blocks = 'apply' }: TestPeriodsEditorProps) {
    // The draft and the change check both work on the start / end only form, so a
    // legacy label on the incoming periods is neither drawn nor read as a change.
    const propsKey = JSON.stringify(toScoringPeriods(tests));
    const [draft, setDraft] = useState<TestPeriod[]>(() => toScoringPeriods(tests));
    useEffect(() => { setDraft(toScoringPeriods(tests)); }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const minAttr = toInputValue(bounds?.min) || undefined;
    const maxAttr = toInputValue(bounds?.max) || undefined;
    const boundsForDays = minAttr && maxAttr ? { min: minAttr, max: maxAttr } : null;
    const statuses = validateTestPeriods(draft);

    const commit = (list: TestPeriod[]) => {
        const sorted = sortScoring(list);
        setDraft(sorted);
        if (JSON.stringify(sorted) !== propsKey) onChange(sorted);
    };
    /** A typed (not yet committed) change of one row's start or end. */
    const type = (i: number, patch: Partial<Pick<TestPeriod, 'start' | 'end'>>) =>
        setDraft(prev => prev.map((t, j) => (j === i ? toScoringPeriod({ ...t, ...patch }) : t)));

    const dateInput = (i: number, which: 'start' | 'end', label: string, bad = false) => (
        <div className={`f4-dtw${bad ? ' f4-dtw--bad' : ''}`}>
            <input
                type="datetime-local"
                aria-label={label}
                value={toInputValue(draft[i][which])}
                min={minAttr}
                max={maxAttr}
                onChange={e => type(i, { [which]: e.target.value })}
                onBlur={() => commit(draft)}
                onKeyDown={e => { if (e.key === 'Enter') commit(draft); }}
            />
        </div>
    );

    return (
        <div className={`tpe-periods${compact ? ' tpe-periods--compact' : ''}`} data-testid="test-periods-editor">
            {draft.length === 0 && (
                <div className="rcm-none rcm-none--warn" data-testid="tests-empty">
                    <span><b>No scoring period yet.</b> You can train, but every model needs a scoring period before Mark complete.</span>
                </div>
            )}
            {draft.map((t, i) => {
                const n = i + 1;
                const st = statuses[i];
                const days = st.invalid ? null : periodDays(t, boundsForDays);
                const note = st.invalid ? null : overlapNote(train, t, i, boundsForDays);
                const reversed = st.invalid && (st.reason ?? '').includes('ends before');
                return (
                    <div key={t.id} className={`rcm-per tpe-per${st.invalid ? ' rcm-per--bad' : ''}`} data-testid={`test-row-${n}`}>
                        <span className="rcm-pn tpe-pn">S{n}</span>
                        {dateInput(i, 'start', `Scoring period ${n} start`)}
                        <span className="rcm-arrow">→</span>
                        <div className="f4-dt-end">{dateInput(i, 'end', `Scoring period ${n} end`, reversed)}</div>
                        <span className="rcm-dur" data-testid={`test-days-${n}`}>{days === null ? '—' : `${days} d`}</span>
                        <button type="button" className="rcm-ib" aria-label={`Remove scoring period ${n}`} title="Remove scoring period" onClick={() => commit(draft.filter((_, j) => j !== i))}>
                            <Trash2 size={14} aria-hidden="true" />
                        </button>
                        {st.invalid && (
                            <div role="alert" className="rcm-permsg rcm-permsg--bad" data-testid={`test-invalid-${n}`}>
                                {st.reason} Fix it to {blocks}.
                            </div>
                        )}
                        {note && <div className="tpe-info" data-testid={`test-overlap-${n}`}>{note}</div>}
                    </div>
                );
            })}
            <button type="button" className="rcm-add" data-testid="test-add" onClick={() => commit([...draft, nextDefaultTestPeriod(train, draft, bounds)])}>
                <Plus size={13} aria-hidden="true" />Add scoring period
            </button>
        </div>
    );
}
