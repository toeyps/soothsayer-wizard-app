import { memo } from 'react';
import type { TestPeriod, TimePeriod } from '../../types';
import type { PeriodCountsState } from '../../utils/periodCounts';
import { runningConditionCaption } from '../../utils/periodCounts';
import { NO_TRAIN_ROWS_TEXT } from '../../utils/runningCondition';
import { periodDataFit, validatePeriods, validateTestPeriods, type PeriodBaseline } from '../../utils/timePeriods';
import { formatYearMonth } from '../../utils/dateFormat';
import { parseLocal } from '../../utils/workbenchDate';
import { boundsMs, formatPeriod, type DataBounds } from './periodDisplay';

/* Timeline of the running-condition settings: month axis, TRAIN lane (P1…), SCORE lane (S1… dashed), invalid in red, one caption (`runningConditionCaption`). A period entirely outside the data is a sliver on the edge it lies beyond (red if new/changed, amber if as saved). No running row in the train periods: one red line says nothing to train on. The caption shows days only, never row counts. Plain DOM in % of the dataset time range; it draws the lists it is given. */

export interface TimelineTick {
    pct: number;
    label: string;
}

/** Max month ticks printed: a label is ~42 px, so 10 still stand apart on a narrow window. */
const MAX_MONTH_TICKS = 10;

/** One tick per month start in [t0, t1], 'YYYY/MM', thinned evenly to `MAX_MONTH_TICKS`. */
export function monthTicks(t0: number, t1: number): TimelineTick[] {
    const span = t1 - t0;
    if (!(span > 0)) return [];
    const out: TimelineTick[] = [];
    const d = new Date(t0);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < t0) d.setMonth(d.getMonth() + 1);
    // 600 months is far beyond any dataset; the guard only stops a bad clock.
    for (let guard = 0; d.getTime() <= t1 && guard < 600; guard++) {
        const ms = d.getTime();
        out.push({
            pct: ((ms - t0) / span) * 100,
            label: formatYearMonth(d),
        });
        d.setMonth(d.getMonth() + 1);
    }
    if (out.length <= MAX_MONTH_TICKS) return out;
    const step = Math.ceil(out.length / MAX_MONTH_TICKS);
    return out.filter((_, i) => i % step === 0);
}

export interface TimelineBlock {
    /** "P1" / "S2". */
    name: string;
    leftPct: number;
    widthPct: number;
    invalid: boolean;
    /** An open side runs to the edge of the dataset. */
    openStart: boolean;
    openEnd: boolean;
    /** Tooltip / accessible text: "P1 · 2026/01/01 00:00 – 2026/02/28 23:59". */
    label: string;
    /** Period lies entirely outside the data: a sliver on that edge (red if `invalid`, else amber for a saved period). */
    outside?: boolean;
}

/** Width (in % of the lane) of the sliver that stands for a period outside the data. */
const OUTSIDE_SLIVER_PCT = 1.2;

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();

/** Each period's place on the dataset range. Open end = dataset bound; reversed = red block between its dates; unreadable date = no block. Wholly outside the data (open-ended included) = sliver on its edge (`outside`; red if `invalid[i]`, else amber). */
export function timelineBlocks(
    list: readonly { start: string; end: string }[],
    invalid: readonly boolean[],
    bounds: DataBounds | null | undefined,
    prefix: 'P' | 'S',
): (TimelineBlock | null)[] {
    const b = boundsMs(bounds);
    if (!b) return list.map(() => null);
    const span = b.t1 - b.t0;
    return list.map((p, i) => {
        const openStart = isBlank(p.start);
        const openEnd = isBlank(p.end);
        const s = openStart ? b.t0 : parseLocal(p.start);
        const e = openEnd ? b.t1 : parseLocal(p.end);
        if (s === null || e === null) return null;
        const a = Math.max(b.t0, Math.min(s, e));
        const z = Math.min(b.t1, Math.max(s, e));
        const name = `${prefix}${i + 1}`;
        // Same rule as the rows (an open bound is unbounded); a reversed period has no fit and keeps its red block between its two dates.
        const fit = periodDataFit(p, bounds);
        if (fit ? fit.outside : z < a) {
            // Nothing of it is inside the data: before the first row, or after the last.
            const after = fit ? fit.after : Math.min(s, e) > b.t1;
            return {
                name,
                leftPct: after ? 100 - OUTSIDE_SLIVER_PCT : 0,
                widthPct: OUTSIDE_SLIVER_PCT,
                // A reversed period is always invalid; an outside one follows its row.
                invalid: fit ? !!invalid[i] : true,
                openStart: false,
                openEnd: false,
                label: `${name} · ${formatPeriod({ id: name, start: p.start, end: p.end })}`,
                outside: true,
            };
        }
        return {
            name,
            leftPct: ((a - b.t0) / span) * 100,
            // Never thinner than a visible sliver.
            widthPct: Math.max(0.6, ((z - a) / span) * 100),
            invalid: !!invalid[i],
            openStart,
            openEnd,
            label: `${name} · ${formatPeriod({ id: name, start: p.start, end: p.end })}`,
        };
    });
}

function Lane({ kind, title, blocks, empty }: { kind: 'train' | 'score'; title: string; blocks: (TimelineBlock | null)[]; empty?: string }) {
    return (
        <div className={`rct-lane rct-lane--${kind === 'train' ? 'tr' : 'sc'}`} data-testid={`rc-timeline-${kind}`}>
            <span className="rct-ln">{title}</span>
            {blocks.map(g => g && (
                <i
                    key={g.name}
                    className={`rct-blk${g.invalid ? ' bad' : g.outside ? ' warn' : ''}${g.openStart ? ' rct-blk--os' : ''}${g.openEnd ? ' rct-blk--oe' : ''}`}
                    data-testid={`rc-tl-${g.name}`}
                    data-invalid={g.invalid ? 'true' : undefined}
                    data-outside={g.outside ? 'true' : undefined}
                    style={{ left: `${g.leftPct.toFixed(2)}%`, width: `${g.widthPct.toFixed(2)}%` }}
                    title={g.outside ? `${g.label} — outside the data${g.invalid ? '' : kind === 'train' ? ', not used' : ', nothing is scored there'}` : g.invalid ? `${g.label} — not valid` : g.label}
                >
                    {/* The name only when the block is wide enough to hold it. */}
                    {g.widthPct > 4 ? g.name : ''}
                </i>
            ))}
            {empty && <span className="rct-empty">{empty}</span>}
        </div>
    );
}

export interface RunningConditionTimelineProps {
    periods: TimePeriod[];
    tests: TestPeriod[];
    bounds: DataBounds | null | undefined;
    counts: PeriodCountsState;
    /** Running condition (as drafted) is configured; default `true`. `false` = 'Only when running' without a complete condition: the count isn't read, so no running time and no 'nothing to train on'. */
    configured?: boolean;
    /** Saved lists: a period unchanged from them that lies outside the data only warns (amber). Omitted = every period is new. */
    savedPeriods?: PeriodBaseline;
    savedTests?: PeriodBaseline;
}

function RunningConditionTimeline({ periods, tests, bounds, counts, configured = true, savedPeriods, savedTests }: RunningConditionTimelineProps) {
    const b = boundsMs(bounds);
    const cap = runningConditionCaption({ trainPeriods: periods, scoringPeriods: tests, bounds, counts, configured, savedTrain: savedPeriods, savedScoring: savedTests });
    const trainBlocks = timelineBlocks(periods, validatePeriods(periods, bounds, savedPeriods).map(s => s.invalid), bounds, 'P');
    const scoreBlocks = timelineBlocks(tests, validateTestPeriods(tests, bounds, savedTests).map(s => s.invalid), bounds, 'S');
    // The dataset this window was opened on is gone: one quiet line.
    const dataChanged = counts.errorCode === 'STALE_SESSION';
    return (
        <section className="rct" data-testid="rc-timeline" aria-label="Timeline of the train and scoring periods">
            {b ? (
                <div
                    role="img"
                    aria-label={`Train periods: ${trainBlocks.filter(Boolean).map(g => g!.label).join('; ') || 'none'}. Scoring periods: ${scoreBlocks.filter(Boolean).map(g => g!.label).join('; ') || 'none'}.`}
                >
                    <div className="rct-axis" aria-hidden="true">
                        {monthTicks(b.t0, b.t1).map(t => <span key={t.pct} style={{ left: `${t.pct.toFixed(2)}%` }}>{t.label}</span>)}
                    </div>
                    <Lane kind="train" title="Train" blocks={trainBlocks} empty={periods.length === 0 ? 'no train period yet' : undefined} />
                    <Lane kind="score" title="Score" blocks={scoreBlocks} />
                </div>
            ) : (
                <div className="rct-nobounds" data-testid="rc-timeline-nobounds">The dataset's time range is not known yet.</div>
            )}
            <div
                className={`rct-cap${cap.belowRecommended ? ' rct-cap--warn' : ''}`}
                data-testid="rc-caption"
                data-rows={cap.rows.kind}
                aria-live="polite"
            >
                <span className="rct-cap-tr" data-testid="rc-caption-train"><i className="tpe-sw tpe-sw--tr" aria-hidden="true" />{cap.trainText}</span>
                <span className="rct-cap-sc" data-testid="rc-caption-scoring"><i className="tpe-sw tpe-sw--te" aria-hidden="true" />{cap.scoringText}</span>
                {dataChanged && (
                    <span className="rct-cap-quiet" data-testid="rc-caption-data-changed">
                        The data changed — close this window and open Build Model again
                    </span>
                )}
                {cap.recommendedText && (
                    // Amber while counted train running time is below the recommendation (never a block); the tooltip has the full sentence.
                    <span
                        className="rct-cap-min"
                        data-testid="rc-min-data"
                        data-below={cap.belowRecommended ? 'true' : undefined}
                        title={cap.warning ?? undefined}
                    >
                        {cap.recommendedText}
                    </span>
                )}
            </div>
            {cap.noRows && (
                // No running row in the train periods: nothing to train on (blocks Train, and Apply/Save if the draft changes the training rows).
                <div className="rct-norows" role="alert" data-testid="rc-no-rows">{NO_TRAIN_ROWS_TEXT}</div>
            )}
        </section>
    );
}

export default memo(RunningConditionTimeline);
