import { memo } from 'react';
import type { TestPeriod, TimePeriod } from '../../types';
import type { PeriodCountsState } from '../../utils/periodCounts';
import { runningConditionCaption } from '../../utils/periodCounts';
import { noTrainRowsText } from '../../utils/runningCondition';
import { periodDataFit, validatePeriods, validateTestPeriods, type PeriodBaseline } from '../../utils/timePeriods';
import { formatYearMonth } from '../../utils/dateFormat';
import { parseLocal } from '../../utils/workbenchDate';
import { boundsMs, formatPeriod, type DataBounds } from './periodDisplay';

/*
 * The timeline hero of the Running-condition settings (workbench redesign SPEC
 * §5): a month axis ("2026/01", "2026/03" …), a TRAIN lane (P1, P2 … in train blue) and a SCORE lane
 * (S1, S2 … dashed, in the scoring colour), an invalid period in red, and the
 * ONE caption under it (`runningConditionCaption`). A period that lies entirely
 * outside the loaded data is a sliver on the edge it lies beyond — red when it
 * is new / changed in the draft (invalid), amber when it is exactly as it was
 * saved (a warning: it is simply not used). When the settled count says the
 * train periods hold no running row, one red line under the caption says there
 * is nothing to train on.
 *
 * Plain DOM positioned in percent of the dataset's time range — no chart
 * library, nothing to resize. It draws the lists it is given: the row editors
 * hand a typed date up as soon as it is complete (a half-typed one stays in its
 * field), so the blocks follow the edit. Drawing / dragging periods here is a
 * later step.
 */

export interface TimelineTick {
    pct: number;
    label: string;
}

/** At most this many month ticks are printed: a label is "2026/01" (7 mono
 *  characters, ~42 px), so 10 of them still stand apart on a narrow window. */
const MAX_MONTH_TICKS = 10;

/** One tick per month start inside [t0, t1], labelled year/month in the app's
 *  date format ("2026/01", "2026/02" …); thinned evenly so at most
 *  `MAX_MONTH_TICKS` are printed. */
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
    /** The period lies entirely outside the dataset: a sliver on that edge
     *  (`invalid` = red, a period new / changed in the draft; else amber — a
     *  saved period, which only warns). */
    outside?: boolean;
}

/** Width (in % of the lane) of the sliver that stands for a period outside the data. */
const OUTSIDE_SLIVER_PCT = 1.2;

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();

/**
 * Where each period sits on the dataset's time range. An open end resolves to
 * the dataset bound; a reversed period is drawn over the time between its two
 * dates (red); a period that lies wholly outside the dataset — an open-ended one
 * included — is a sliver on the edge it lies beyond (`outside`; red when
 * `invalid[i]`, amber for a saved period that only warns — its row says which);
 * a period with an unreadable date has no block (its row says what is wrong).
 */
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
        // The SAME rule the rows are judged by (an open bound is unbounded there,
        // so "open start … ends before the data" is outside too); a reversed
        // period has no fit — it keeps its red block between its two dates.
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
    /** The running condition (as drafted) is configured. `false` = "Only when
     *  running" without a complete condition: the caption asks for the condition
     *  instead of counting every row. Default `true`. */
    configured?: boolean;
    /** "Use all rows" is chosen: there is no condition to relax, so the no-rows
     *  line only says "Widen a train period". Default `false`. */
    usesAllRows?: boolean;
    /** The lists as they are SAVED: a period unchanged from them that lies
     *  outside the data only warns (amber sliver). Omitted = every period is new. */
    savedPeriods?: PeriodBaseline;
    savedTests?: PeriodBaseline;
}

function RunningConditionTimeline({ periods, tests, bounds, counts, configured = true, usesAllRows = false, savedPeriods, savedTests }: RunningConditionTimelineProps) {
    const b = boundsMs(bounds);
    const cap = runningConditionCaption({ trainPeriods: periods, scoringPeriods: tests, bounds, counts, configured, savedTrain: savedPeriods, savedScoring: savedTests });
    const trainBlocks = timelineBlocks(periods, validatePeriods(periods, bounds, savedPeriods).map(s => s.invalid), bounds, 'P');
    const scoreBlocks = timelineBlocks(tests, validateTestPeriods(tests, bounds, savedTests).map(s => s.invalid), bounds, 'S');
    const rows = cap.rows;
    // The dataset this window was opened on is gone: one quiet line, never numbers.
    const errorLine = counts.errorCode === 'STALE_SESSION'
        ? 'The data changed — close this window and open Build Model again to count the rows'
        : cap.rowsText;
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
                data-rows={rows.kind}
                aria-live="polite"
            >
                <span className="rct-cap-tr" data-testid="rc-caption-train"><i className="tpe-sw tpe-sw--tr" aria-hidden="true" />{cap.trainText}</span>
                <span className="rct-cap-sc" data-testid="rc-caption-scoring"><i className="tpe-sw tpe-sw--te" aria-hidden="true" />{cap.scoringText}</span>
                {rows.kind !== 'idle' && (
                    <span
                        className={`rct-cap-rows${rows.kind === 'counted' && rows.stale ? ' rct-stale' : ''}${rows.kind === 'error' ? ' rct-cap-quiet' : ''}`}
                        data-testid="rc-caption-rows"
                        data-stale={rows.kind === 'counted' && rows.stale ? 'true' : undefined}
                    >
                        {rows.kind === 'counted'
                            ? <><b>{rows.used.toLocaleString('en-US')}</b> of {rows.total.toLocaleString('en-US')} rows ({rows.percent}) used for training</>
                            : rows.kind === 'error' ? errorLine : cap.rowsText}
                    </span>
                )}
                {cap.recommendedText && (
                    // Amber while the counted train running time is below the
                    // recommendation (never a block); the full sentence is the tooltip.
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
                // The settled count of what is on screen: no running row in the train
                // periods — nothing to train on (Train is blocked; Apply / Save
                // changes too when this draft changed what is trained on).
                <div className="rct-norows" role="alert" data-testid="rc-no-rows">{noTrainRowsText(!usesAllRows)}</div>
            )}
        </section>
    );
}

export default memo(RunningConditionTimeline);
