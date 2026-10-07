import { useEffect, useState } from 'react';
import { Highlighter, Plus, Trash2 } from 'lucide-react';
import type { TestPeriod, TimeHighlight, TimePeriod } from '../../types';
import {
    newPeriodId,
    periodsOverlap,
    sortPeriods,
    testIncludesTrainNote,
    trainOverlapDays,
    validateTestPeriods,
} from '../../utils/timePeriods';
import { formatDate, periodDays } from './periodDisplay';
import type { PeriodBounds } from './TimePeriodsEditor';

/*
 * Train/Test validation (SPEC FINAL 2026-10-07, rules 3, 5, 6): the "Test
 * periods" list — the time ranges where a model's health score is CHECKED. Used
 * by the Running condition modal (workspace default) and by a Custom model's own
 * Model settings (`compact`).
 *
 * One row per test period: T# · start → end · Normal | Known problem · days ·
 * remove. A Known problem can carry an optional event time (when the failure was
 * found); it must lie inside its period, otherwise it is red and the caller's
 * Apply / Save is blocked (`runningConditionApplyBlock` / `testPeriodsError`).
 * A test period MAY overlap the train periods: a neutral grey note says how many
 * days of train time it includes — never a block (rule 3).
 *
 * "From Highlights" copies a Dashboard time highlight's range into a new test
 * period; the Normal / Known problem label lives on the test period only, never
 * on the highlight (rule 6).
 *
 * Dates are edited in a local draft and committed on blur / Enter (never per
 * keystroke — a half-typed `datetime-local` reports '' and must not reset the
 * field), same as `TimePeriodsEditor`. The list is kept in time order, so T1,
 * T2 … read left to right on the charts.
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

/** Default range of "Add test period": 14 days starting one minute after the
 *  latest end among the train and test periods (so it does not touch train
 *  time), else at the dataset start; clamped to the dataset end. */
export function nextDefaultTestPeriod(train: TimePeriod[], tests: TestPeriod[], bounds: PeriodBounds | null | undefined): TestPeriod {
    const min = toInputValue(bounds?.min);
    const max = toInputValue(bounds?.max);
    const ends = [...train, ...tests].map(p => toInputValue(p.end)).filter(Boolean).sort();
    const lastEnd = ends.length ? ends[ends.length - 1] : '';
    let startMs = lastEnd ? (msOf(lastEnd) ?? 0) + 60_000 : msOf(min);
    const maxMs = msOf(max);
    if (startMs !== null && maxMs !== null && startMs >= maxMs) startMs = msOf(min);
    if (startMs === null) return { id: newPeriodId(), start: '', end: '', label: 'normal' };
    let endMs = startMs + 14 * 86_400_000;
    if (maxMs !== null && endMs > maxMs) endMs = maxMs;
    return { id: newPeriodId(), start: fmtLocal(startMs), end: fmtLocal(endMs), label: 'normal' };
}

const sortTests = (list: TestPeriod[]) => sortPeriods(list) as TestPeriod[];

/** The neutral "includes N d of train running time" note of row `i` (rule 3), or null. */
function overlapNote(train: TimePeriod[], t: TestPeriod, i: number, bounds: { min: string; max: string } | null): string | null {
    if (!train.some(p => periodsOverlap(p, t))) return null;
    const days = trainOverlapDays(train, t, bounds);
    if (days >= 1) return `${testIncludesTrainNote(i, days)}.`;
    return `T${i + 1} includes less than 1 d of train running time — results include rows the model was trained on.`;
}

export interface TestPeriodsEditorProps {
    tests: TestPeriod[];
    /** The train periods next to them (for the overlap note and the Add default). */
    train: TimePeriod[];
    onChange: (next: TestPeriod[]) => void;
    /** The workspace's Dashboard time highlights ("From Highlights"). */
    highlights: TimeHighlight[];
    /** True dataset extent (`useDatasetTimeBounds`): defaults, min/max, day counts. */
    bounds?: PeriodBounds | null;
    /** Narrow variant for a Custom model's Model settings. */
    compact?: boolean;
    /** The "From Highlights" menu opened — lets the host re-read the highlights. */
    onHighlightsMenuOpen?: () => void;
    /** What an invalid row blocks, for its message ("Fix it to apply" in the
     *  Running condition modal, "Fix it to save" in a Custom model's settings,
     *  where it blocks Save changes). Default `'apply'`. */
    blocks?: 'apply' | 'save';
}

export default function TestPeriodsEditor({ tests, train, onChange, highlights, bounds, compact = false, onHighlightsMenuOpen, blocks = 'apply' }: TestPeriodsEditorProps) {
    const [draft, setDraft] = useState<TestPeriod[]>(tests);
    const [menuOpen, setMenuOpen] = useState(false);
    const propsKey = JSON.stringify(tests);
    useEffect(() => { setDraft(tests); }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const minAttr = toInputValue(bounds?.min) || undefined;
    const maxAttr = toInputValue(bounds?.max) || undefined;
    const boundsForDays = minAttr && maxAttr ? { min: minAttr, max: maxAttr } : null;
    const statuses = validateTestPeriods(draft);

    const commit = (list: TestPeriod[]) => {
        const sorted = sortTests(list);
        setDraft(sorted);
        if (JSON.stringify(sorted) !== propsKey) onChange(sorted);
    };
    /** A typed (not yet committed) change of one row. */
    const type = (i: number, patch: Partial<TestPeriod>) => setDraft(prev => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    /** A discrete change of one row (label, remove …): committed at once. */
    const set = (i: number, patch: Partial<TestPeriod>) => commit(draft.map((t, j) => (j === i ? { ...t, ...patch } : t)));

    const usable = highlights.filter(h => h.enabled !== false);
    const isUsed = (h: TimeHighlight) =>
        draft.some(t => toInputValue(t.start) === toInputValue(h.start) && toInputValue(t.end) === toInputValue(h.end));
    const fromHighlight = (h: TimeHighlight, label: TestPeriod['label']) => {
        const [a, b] = toInputValue(h.start) <= toInputValue(h.end) ? [h.start, h.end] : [h.end, h.start];
        commit([...draft, { id: newPeriodId(), start: toInputValue(a), end: toInputValue(b), label, ...(h.label ? { fromHighlight: h.label } : {}) }]);
        setMenuOpen(false);
    };
    const toggleMenu = () => {
        if (!menuOpen) onHighlightsMenuOpen?.();
        setMenuOpen(o => !o);
    };

    const dateInput = (i: number, which: 'start' | 'end' | 'eventTime', label: string, bad = false) => (
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
                    <span><b>No test period yet.</b> You can train, but every model needs a test period before Mark complete.</span>
                </div>
            )}
            {draft.map((t, i) => {
                const n = i + 1;
                const st = statuses[i];
                const days = st.invalid ? null : periodDays(t, boundsForDays);
                const note = st.invalid ? null : overlapNote(train, t, i, boundsForDays);
                const reversed = st.invalid && (st.reason ?? '').includes('ends before');
                return (
                    <div key={t.id} className={`rcm-per tpe-per${st.invalid || st.eventInvalid ? ' rcm-per--bad' : ''}`} data-testid={`test-row-${n}`} data-label={t.label}>
                        <span className="rcm-pn tpe-pn">T{n}</span>
                        {dateInput(i, 'start', `Test period ${n} start`)}
                        <span className="rcm-arrow">→</span>
                        <div className="f4-dt-end">{dateInput(i, 'end', `Test period ${n} end`, reversed)}</div>
                        <div className="tpe-lab" role="group" aria-label={`T${n}: what happened in this period`}>
                            <button
                                type="button"
                                data-testid={`test-label-normal-${n}`}
                                className={t.label === 'normal' ? 'on' : undefined}
                                aria-pressed={t.label === 'normal'}
                                onClick={() => { if (t.label !== 'normal') set(i, { label: 'normal' }); }}
                            >
                                Normal
                            </button>
                            <button
                                type="button"
                                data-testid={`test-label-problem-${n}`}
                                className={t.label === 'problem' ? 'on tpe-pb' : undefined}
                                aria-pressed={t.label === 'problem'}
                                onClick={() => { if (t.label !== 'problem') set(i, { label: 'problem' }); }}
                            >
                                Known problem
                            </button>
                        </div>
                        <span className="rcm-dur" data-testid={`test-days-${n}`}>{days === null ? '—' : `${days} d`}</span>
                        <button type="button" className="rcm-ib" aria-label={`Remove test period ${n}`} title="Remove test period" onClick={() => commit(draft.filter((_, j) => j !== i))}>
                            <Trash2 size={14} aria-hidden="true" />
                        </button>
                        {t.label === 'problem' && (
                            <div className={`tpe-ev${st.eventInvalid ? ' tpe-ev--bad' : ''}`}>
                                <span className="tpe-evl">Event time</span>
                                {dateInput(i, 'eventTime', `Test period ${n} event time`, st.eventInvalid)}
                                <small>Optional · when the failure was found (or the machine was stopped). Wizard then reports how many days earlier the score fell below 80.</small>
                            </div>
                        )}
                        {st.invalid && (
                            <div role="alert" className="rcm-permsg rcm-permsg--bad" data-testid={`test-invalid-${n}`}>
                                {st.reason} Fix it to {blocks}.
                            </div>
                        )}
                        {!st.invalid && st.eventInvalid && (
                            <div role="alert" className="rcm-permsg rcm-permsg--bad" data-testid={`test-event-invalid-${n}`}>
                                {st.eventReason} {(t.start && t.end) ? `(${formatDate(t.start)} – ${formatDate(t.end)})` : ''} Fix it, or clear it, to {blocks}.
                            </div>
                        )}
                        {t.fromHighlight && <div className="tpe-from">From highlight “{t.fromHighlight}”</div>}
                        {note && <div className="tpe-info" data-testid={`test-overlap-${n}`}>{note}</div>}
                    </div>
                );
            })}
            <div className="tpe-actions">
                <button type="button" className="rcm-add" data-testid="test-add" onClick={() => commit([...draft, nextDefaultTestPeriod(train, draft, bounds)])}>
                    <Plus size={13} aria-hidden="true" />Add test period
                </button>
                <button
                    type="button"
                    className="rcx-btn rcx-btn--sm"
                    data-testid="test-from-hl"
                    aria-expanded={menuOpen}
                    disabled={usable.length === 0}
                    title={usable.length ? 'Use a Dashboard highlight as a test period' : 'No highlights on the Dashboard yet'}
                    onClick={toggleMenu}
                >
                    <Highlighter size={13} aria-hidden="true" /> From Highlights ▾
                </button>
            </div>
            {menuOpen && usable.length > 0 && (
                <div className="tpe-menu" data-testid="test-hl-menu" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false); } }}>
                    {usable.map(h => {
                        const used = isUsed(h);
                        const ovl = train.some(p => periodsOverlap(p, { start: h.start, end: h.end }));
                        return (
                            <div key={h.id} className="tpe-mi" data-testid={`test-hl-item-${h.id}`}>
                                <i style={{ background: h.color }} aria-hidden="true" />
                                <div className="tpe-mi-t">
                                    <b>{h.label || 'Highlight'}</b>
                                    <small>{formatDate(h.start)} → {formatDate(h.end)}{used ? ' · already a test period' : ''}</small>
                                    {ovl && <small className="tpe-mi-info">Includes train time</small>}
                                </div>
                                {!used && (
                                    <>
                                        <button type="button" className="rcx-btn rcx-btn--sm" data-testid={`test-hl-normal-${h.id}`} onClick={() => fromHighlight(h, 'normal')}>Normal</button>
                                        <button type="button" className="rcx-btn rcx-btn--sm" data-testid={`test-hl-problem-${h.id}`} onClick={() => fromHighlight(h, 'problem')}>Known problem</button>
                                    </>
                                )}
                            </div>
                        );
                    })}
                    <small className="tpe-mi-note">Highlights come from the Dashboard's Highlights tab. The Normal / Known problem label is kept on the test period only.</small>
                </div>
            )}
        </div>
    );
}
