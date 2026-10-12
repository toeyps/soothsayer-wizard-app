import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { samePageProps } from './pageMemo';
import { connect } from 'echarts';
import { Loader2 } from 'lucide-react';
import ResponsiveECharts from '../../charts/ResponsiveECharts';
import type { HealthIssue, HealthPreview, ScoreSummary } from '../../../types/health';
import { SensorInline } from '../../sensor/SensorLabel';
import { useSensorLookup } from '../../sensor/sensorInfo';
import ChartCard from './ChartCard';
import ChecksCard from './ChecksCard';
import ScoreRuler from './ScoreRuler';
import { Kpi, KpiStrip } from './Kpi';
import {
    healthVerdict,
    hoverIndexFromAxisEvent,
    readoutAt,
    readoutText,
    verdictOfIssues,
    type HealthVerdict,
} from './healthChecks';
import {
    HEALTH_SYNC_GROUP,
    HEALTH_SYNC_GROUP_EXPANDED,
    asStackLower,
    asStackUpper,
    buildClusterSetPointOption,
    buildIndividualSetPointOption,
    buildRelationshipSetPointOption,
    buildScoreOption,
} from './healthPageCharts';
import { hourlyScopes, scopesOf, sensorAxisTitle, type TimeScopes } from './healthCharts';
import { formatDataStamp } from '../periodDisplay';
import { SlowScoringNotice, TestScoringFailedNotice, TestsChangedBanner } from './ValidationCards';
import { testScoringFailure } from '../../../utils/trainTestValidation';
import { FitGoneBoard, LoadFailedBoard, StateBoard, TrainSensorLink } from './WorkbenchShellParts';
import type { HealthScorePageProps, SaveInfo } from './workbenchTypes';

/*
 * Page 2 of the Workbench - "Health score" body:
 *
 *   [ Lowest score ] [ Below 80 ] [ Share of scored hours ]   the KPI tiles
 *   [ Health set points: the score ruler + footnote + the Checks     ]
 *   [ ONE chart card:  the set-point chart                           ]
 *   [                  ------------------------------------------    ]
 *   [                  the health score (locked until valid)         ]
 *
 * One column: every card is as wide as the board. The two charts of the stacked card
 * share ONE time axis (same plot margins, one cursor, one zoom window), so a spike is
 * read straight down to its score.
 *
 * Everything is drawn from the ONE bounded `HealthPreview` the container's
 * `useHealthPreview` returns for the DRAFT set points (so typing moves the
 * lines, the score and the Checks within ~250 ms). The footer (<- Model fit,
 * status, Mark complete) is rendered by the container, because Mark complete
 * shares its persist flow.
 *
 * 1-HOUR AVERAGES: the health score is computed on one point per clock hour (the
 * mean of the hour's running rows), so EVERY chart and number of this page reads
 * `data.hourly` — the set-point chart, the score chart, the read-out and the
 * Clustering points share that ONE index set. `data.series` (the raw rows, never
 * scored) belongs to the Model fit page and is not read here.
 *
 * Hover: the two time charts (Individual / Relationship) are connected in one
 * ECharts group, so one timestamp cursor shows on both; the page ALSO keeps the
 * hovered `hourly` index to print "hour - 1 h average - score" in the stacked card's
 * header. Clustering has no time axis on its set-point chart, so hovering
 * a point there (or the score chart) highlights the same hour on the other.
 *
 * No legend rows: every line is labelled on its
 * chart — reference lines at the right edge, the user's set points with their
 * typed value, the ring levels at the ring's edge — and the score bands are read
 * off the "Share of scored hours" tile at the top of the page.
 */

/** Memo comparison (see `samePageProps`): the small data the window rebuilds per
 *  render (model, set points, save record, tests-changed state, scoring-period numbers)
 *  by value, everything else by identity — the callbacks must be stable. */
export function sameHealthScoreProps(a: HealthScorePageProps, b: HealthScorePageProps): boolean {
    const { fitGone: fa, ...ra } = a;
    const { fitGone: fb, ...rb } = b;
    return sameFitGone(fa, fb)
        && samePageProps(ra, rb, ['model', 'setPoints', 'save', 'testsChanged', 'testNumbers', 'attemptIssues']);
}

/** `fitGone` is rebuilt by the window on every render: same when its fields are. */
function sameFitGone(a: HealthScorePageProps['fitGone'], b: HealthScorePageProps['fitGone']): boolean {
    return a.onReload === b.onReload && a.onGoTrainSensor === b.onGoTrainSensor
        && (a.reloadDisabledReason ?? null) === (b.reloadDisabledReason ?? null) && (a.error ?? null) === (b.error ?? null)
        && !!a.gone === !!b.gone;
}

/** A save that has been running this long gets a line on the page; until then
 *  the footer sentence ("Saving the model files…") says it alone. */
export const SLOW_SAVE_NOTICE_MS = 4000;

/** `flag`, but only once it has stayed true for `delayMs` (false at once). */
function useHeldFor(flag: boolean, delayMs: number): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        if (!flag) {
            setOn(false);
            return;
        }
        const t = setTimeout(() => setOn(true), delayMs);
        return () => clearTimeout(t);
    }, [flag, delayMs]);
    return flag && on;
}

function HealthScorePage(props: HealthScorePageProps) {
    const { model, stale, preview, unit, setPoints, attemptIssues, save } = props;
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);
    // One zoom window for the two time charts, kept when either is redrawn — and a second
    // one for their enlarged copy in the Expand overlay. (Hooks: they must stay above the
    // early returns of the state boards below.)
    const zoom = useSharedZoom(props.model.id);
    const zoomExpanded = useSharedZoom(props.model.id, 'expanded');
    // A failed request leaves `preview.data` null, but when an earlier answer for this
    // model exists the page (inputs, charts) stays on screen from `lastData` under the
    // red card with its Retry instead of being replaced.
    // A Relation-model fit that is gone from memory (NOT_FITTED) has its own board —
    // by the live answer, or by what the window knows (`fitGone.gone`): after a load
    // that failed and a tab switch away and back, no request is asked any more, so
    // `preview.notFitted` is no longer set while the fit is still gone.
    const fitIsGone = preview.notFitted || !!props.fitGone.gone;
    const failed = !preview.data && !fitIsGone && !!preview.error;
    // The NEXT request after a failure (Retry, or a set point typed under the red card)
    // clears `error` while `data` is still null: the page must stay exactly where it is
    // — replacing it by the "Loading…" board would unmount the input being typed in.
    const asking = !preview.data && !preview.error && preview.loading && !!preview.lastData;
    // The page is drawn from the last good answer, which does not describe what is typed.
    const errorMode = (failed || asking) && !!preview.lastData;
    const data = preview.data ?? (errorMode ? preview.lastData ?? null : null);
    // Train / scoring scopes of the time charts (null = no scoring periods sent): the line
    // shows the hours of both; only the train periods are highlighted and named.
    // Memoised on the payload so a hover re-render never rebuilds the time charts.
    const validation = data?.test_validation;
    // S-numbers of the sent scoring periods: memoised on their VALUE (the container
    // builds a new array every render).
    const testNumbers = props.testNumbers;
    const numbersKey = testNumbers ? testNumbers.join(',') : '';
    const scopes = useMemo(
        // This page plots hourly points, so each period starts at its hour start (`hourlyScopes`).
        () => hourlyScopes(scopesOf(validation, numbersKey ? numbersKey.split(',').map(Number) : null)),
        [validation, numbersKey],
    );
    const slowSave = useHeldFor(save.phase === 'running', SLOW_SAVE_NOTICE_MS);
    // A new request cannot be fixed by asking again after the dataset changed.
    const canRetry = !!props.onRetryPreview && preview.errorCode !== 'STALE_SESSION';
    // The ONE shape of "the preview failed", with or without an earlier
    // answer under it: a red card, the reason, Retry. Mark complete is disabled
    // meanwhile and the footer says why.
    const errorCard = failed ? (
        <div className="hs-save hs-save--bad hs-full" role="alert" data-testid="health-error">
            <span>
                <b>Couldn't load the health score.</b>{' '}
                <span data-testid="health-error-reason">{String(preview.error ?? '').trim().replace(/\.$/, '')}</span>
                {' '}· the score and Checks are not available until it loads
            </span>
            <span className="wb2-sp" />
            {canRetry && <button type="button" className="rcx-btn rcx-btn--sm" data-testid="health-retry" onClick={props.onRetryPreview}>Retry</button>}
        </div>
    ) : asking ? (
        // Same place as the red card it follows, so nothing under it moves.
        <div className="hs-save hs-full" role="status" data-testid="health-asking">
            <Loader2 size={14} className="pm-spin" aria-hidden="true" />
            <span><b>Loading the health score again…</b> the score and Checks are not available until it loads</span>
        </div>
    ) : null;
    const loadingBoard = (
        <StateBoard
            testId="health-loading"
            className="hs-full hs-stateboard"
            tone="run"
            title={`Loading the ${model.kind === 'relationship' ? 'Relation model' : `${model.kind === 'clustering' ? 'Clustering' : 'Individual'} model`}…`}
            text="The set points and the score appear here when it is ready."
        />
    );

    if (!data) {
        // The model's own load (or train) failed in this session, so no preview is asked
        // for at all: without this the page would read "Loading…" for ever.
        const loadError = !fitIsGone && !props.fitLoading ? props.fitGone.error ?? null : null;
        const kindName = model.kind === 'relationship' ? 'Relation model' : `${model.kind === 'clustering' ? 'Clustering' : 'Individual'} model`;
        return (
            <div className="wb2-board" data-testid="health-page">
                <SaveBanner save={save} slow={slowSave} relation={model.kind === 'relationship'} />
                <SlowScoringNotice show={props.slowScoring} />
                {!loadError && errorCard}
                {loadError ? (
                    props.fitGone.onGoTrainSensor ? (
                        // Not Complete: Train sensor trains it again (a failed run = ready).
                        <StateBoard
                            testId="health-train-failed"
                            className="hs-full hs-stateboard"
                            tone="bad"
                            title="Training failed"
                            text={<>Fix the problem, then train again with <TrainSensorLink testId="health-go-train-sensor" onClick={props.fitGone.onGoTrainSensor} />. Your set points are kept.</>}
                            detail={loadError}
                        />
                    ) : (
                        // Complete: Train sensor never trains it — "Load it again" is the way out.
                        <LoadFailedBoard
                            testId="health-load-failed"
                            linkTestId="health-load-again"
                            className="hs-full hs-stateboard"
                            kindName={kindName}
                            tail="Your set points are kept and scored again when it is loaded."
                            error={loadError}
                            onReload={props.fitGone.onReload}
                            reloadDisabledReason={props.fitGone.reloadDisabledReason}
                        />
                    )
                ) : fitIsGone ? (
                    // The fit is being loaded again (silently, or "Load it again"): say so.
                    // Otherwise ONE board, no button of its own: "Load it again" (nothing
                    // about the model changed) and, when it trains this model, "Train sensor ↑".
                    props.fitLoading ? loadingBoard : (
                        <FitGoneBoard
                            testId="health-not-fitted"
                            linkTestId="health-load-fit"
                            trainTestId="health-go-train-sensor"
                            className="hs-full hs-stateboard"
                            tail="Your set points are kept and scored again when it is loaded."
                            actions={props.fitGone}
                        />
                    )
                ) : !failed && loadingBoard}
            </div>
        );
    }

    // While an error shows, the old answer's verdict / issues / score do not describe the set
    // points on screen: nothing is judged until the next request lands.
    const issues = errorMode ? [] : attemptIssues ?? data.validation;
    const verdict = errorMode ? null : attemptIssues ? verdictOfIssues(attemptIssues) ?? healthVerdict(data) : healthVerdict(data);
    const scoreReady = !errorMode && data.valid && !!data.hourly.score && !!data.score_summary;
    // "The health score could not be calculated" (the Relation model's engine did not
    // answer for the hours to score). With no scored hour at all the notice stands in the
    // score chart's place — the lower half of the stacked card; when some hours WERE
    // scored (the training hours), it is a card of its own above the charts and the score
    // chart is still drawn. (The "Scoring results" card that used to
    // carry it — one tile per scoring period — was removed 2026-10-12, user decision: not
    // used. The KPI tiles at the top keep the facts for ALL scored hours; there is never a
    // tile per scoring period.)
    const scoringFailure = errorMode ? null : testScoringFailure(data);
    const anyScored = !!data.hourly.score?.some(v => v !== null);
    const retryScoring = canRetry ? (props.onRetryTestScoring ?? props.onRetryPreview) : undefined;
    // The score chart is drawn when there is a score to draw — and not under a failure
    // that left no hour scored (an empty chart would say nothing).
    const score = scoreReady && data.hourly.score && !(scoringFailure && !anyScored) ? data.hourly.score : null;

    return (
        <div className="wb2-board hs-board" data-testid="health-page" data-valid={String(data.valid)}>
            {/* The page's numbers first, as tiles — they replace the score chart's old
                subtitle and the "Share of scored hours" card. */}
            <ScoreKpis summary={scoreReady ? data.score_summary : null} state={errorMode ? 'error' : scoreReady ? 'ready' : 'locked'} />
            <SaveBanner save={save} slow={slowSave} relation={model.kind === 'relationship'} />
            <SlowScoringNotice show={props.slowScoring} />
            {errorCard}
            <TestsChangedBanner state={props.testsChanged} />
            {/* The ruler: value → score in one band, the user's points its only inputs, its
                footnote, then the Checks — ONE card, as wide as the board. */}
            <ScoreRuler
                data={data}
                setPoints={setPoints}
                unit={unit}
                issues={issues}
                verdict={verdict}
                unchecked={errorMode}
                onChange={props.onSetPointsChange}
                onCommit={props.onSetPointsCommit}
            >
                <ChecksCard kind={data.kind} issues={issues} verdict={verdict} unavailable={errorMode} testNumbers={testNumbers} />
            </ScoreRuler>
            {/* "Changed after saving" is said ONCE — the footer sentence, next to its
                "Mark complete again" button. */}
            {scoringFailure && score && (
                <section className="hs-card hs-full" data-testid="score-failed">
                    <div className="wb2-card-h"><b>Health score</b></div>
                    <TestScoringFailedNotice issue={scoringFailure} onRetry={retryScoring} testNumbers={testNumbers} />
                </section>
            )}
            {/* ONE card, two charts on one time axis: the set-point chart above, the score
                under it, one linked cursor and one zoom window. (Clustering has no time axis
                on its set-point chart — the scatter sits above the score chart; hovering an
                hour on either highlights it on the other.) */}
            <StackCharts
                data={data}
                props={props}
                hoverIdx={hoverIdx}
                onHover={setHoverIdx}
                stale={stale}
                unit={unit}
                scopes={scopes}
                zoom={zoom}
                zoomExpanded={zoomExpanded}
                score={score}
                lock={lockReason(errorMode, verdict)}
                lockText={scoreLockText(verdict)}
                failure={score ? null : scoringFailure}
                onRetryFailure={retryScoring}
                testNumbers={testNumbers}
            />
        </div>
    );
}

/** Why the score area is locked        </div>
    );
}

/** Why the score area is locked: the request failed (`error`), a set point is rejected
 *  (`bad`), or nothing is rejected but the score cannot be drawn yet (`empty`). */
export function lockReason(errorMode: boolean, verdict: HealthVerdict | null): 'error' | 'bad' | 'empty' {
    return errorMode ? 'error' : verdict === 'bad' ? 'bad' : 'empty';
}

/** The sentence in the locked score area: it sends the user to the ruler above — to FIX a
 *  rejected point, or to SET the points that are still empty. */
export function scoreLockText(verdict: HealthVerdict | null): string {
    return verdict === 'bad'
        ? 'Fix the set point on the ruler above — the score appears here'
        : 'Set every point on the ruler above — the score appears here';
}

// ---------------------------------------------------------------------------
// A FAILED save, and a save that is taking long. Saving is otherwise said by the
// footer alone ("Saving the model files…" next to its button), and a successful
// save is the footer sentence too ("Files saved 2026/02/09 23:50 · …\output\TAG").
// ---------------------------------------------------------------------------

function SaveBanner({ save, slow, relation }: { save: SaveInfo; slow: boolean; relation: boolean }) {
    if (save.phase === 'running' && slow) {
        return (
            <div className="hs-save hs-full" role="status" data-testid="save-running">
                <Loader2 size={14} className="pm-spin" aria-hidden="true" />
                <span>
                    <b>Still saving…</b>
                    {relation ? ' The Relation model is fitted again for the saved files and its scoring periods are scored. This can take longer than 15 seconds, especially the first time.' : ' Writing the model files is taking longer than usual.'}
                </span>
            </div>
        );
    }
    if (save.phase !== 'error') return null;
    // The reason carries the file (Rust names the file or folder it could not write).
    return (
        <div className="hs-save hs-save--bad hs-full" role="alert" data-testid="save-error">
            <span><b>The model was not saved.</b> <span data-testid="save-error-reason">{save.message}</span></span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The linked pair of time charts: one cursor group, one zoom window
// ---------------------------------------------------------------------------

/** Which pair a `useSharedZoom` serves: the two charts on the page, or their enlarged
 *  copy inside the Expand overlay (ChartCard's `.pm-chart-modal-backdrop`). */
export type ZoomScope = 'page' | 'expanded';

/** Join the ECharts group so the pair of time charts share one cursor.
 *  The pair on the page and its ENLARGED copy are two separate groups, and a chart only
 *  ever joins the one it is drawn in: the charts under the backdrop must not answer the
 *  overlay's hover with a cursor and tooltip of their own (they showed through, over the
 *  overlay), and a zoom in the overlay redraws only the charts in it. */
function joinSyncGroup(inst: { group?: string; getDom?: () => Element | null } | null | undefined, scope: ZoomScope): boolean {
    if (!inst) return false;
    try {
        const enlarged = !!inst.getDom?.()?.closest('.pm-chart-modal-backdrop');
        if (enlarged !== (scope === 'expanded')) return false;
        const group = scope === 'expanded' ? HEALTH_SYNC_GROUP_EXPANDED : HEALTH_SYNC_GROUP;
        inst.group = group;
        connect(group);
        return true;
    } catch {
        // No sync is not worth breaking the page for.
        return false;
    }
}

/** What the shared zoom needs of a chart instance. */
interface ZoomChart {
    group?: string;
    getDom?: () => Element | null;
    isDisposed?: () => boolean;
    getOption?: () => { dataZoom?: { start?: number; end?: number }[] } | undefined;
    dispatchAction?: (payload: Record<string, unknown>) => void;
}

export interface SharedZoom {
    /** `onChartReady` of a time chart: joins the cursor group and takes the current window. */
    join: (inst: ZoomChart | null | undefined) => void;
    /** `datazoom` of a time chart (echarts-for-react passes the instance second). */
    onZoom: (e: unknown, inst?: ZoomChart) => void;
    /** After a chart was redrawn from a new option (which starts unzoomed): the window again. */
    restore: () => void;
}

/** The time window a chart shows, in percent of its X range; null when it cannot be read. */
function zoomWindowOf(inst: ZoomChart): [number, number] | null {
    try {
        const z = inst.getOption?.()?.dataZoom?.[0];
        return z && typeof z.start === 'number' && typeof z.end === 'number' ? [z.start, z.end] : null;
    } catch {
        return null;
    }
}

/**
 * ONE zoom window for the page's two time charts (the sensor value / the residual,
 * and the health score — stacked in one card). They are the same width and share
 * the plot margins, so with the same window a moment in time is at the same X in
 * both — the user reads a spike straight down to its score (real-app request
 * 2026-10-12: "no need to line the point up by eye").
 *
 * The ECharts group already forwards a wheel zoom, but a chart REDRAWN from a new
 * option (a set point edited, a new score) starts unzoomed while the other keeps
 * its window — the two then showed different spans. So the window is kept here:
 * each zoom records it and pushes it to the other chart, and a redraw puts it back.
 * A different model starts unzoomed.
 *
 * `scope` picks the pair it serves: the charts on the page (the default) or their
 * enlarged copy in the Expand overlay — each pair has its own cursor group and its own
 * window, and a chart drawn in the other place is never joined.
 */
export function useSharedZoom(resetKey: string, scope: ZoomScope = 'page'): SharedZoom {
    const state = useRef<{ key: string; win: [number, number] | null; charts: Set<ZoomChart>; busy: boolean }>({ key: resetKey, win: null, charts: new Set(), busy: false });
    if (state.current.key !== resetKey) state.current = { key: resetKey, win: null, charts: state.current.charts, busy: false };
    return useMemo<SharedZoom>(() => {
        const st = () => state.current;
        const apply = (inst: ZoomChart) => {
            const w = st().win;
            if (!w || inst.isDisposed?.()) return;
            const cur = zoomWindowOf(inst);
            if (cur && Math.abs(cur[0] - w[0]) < 0.01 && Math.abs(cur[1] - w[1]) < 0.01) return;
            // escapeConnect: this IS the sync — the group must not send it round again.
            inst.dispatchAction?.({ type: 'dataZoom', dataZoomIndex: 0, start: w[0], end: w[1], escapeConnect: true });
        };
        const each = (f: (inst: ZoomChart) => void, except?: ZoomChart) => {
            for (const inst of [...st().charts]) {
                if (inst.isDisposed?.()) { st().charts.delete(inst); continue; }
                if (inst !== except) f(inst);
            }
        };
        return {
            join: inst => {
                if (!inst || !joinSyncGroup(inst, scope)) return;
                st().charts.add(inst);
                apply(inst);
            },
            onZoom: (_e, inst) => {
                if (!inst || st().busy || !st().charts.has(inst)) return;
                const w = zoomWindowOf(inst);
                if (!w) return;
                st().win = w[0] <= 0.01 && w[1] >= 99.99 ? null : w;
                const target: [number, number] = st().win ?? [0, 100];
                st().busy = true;
                try {
                    each(other => {
                        const cur = zoomWindowOf(other);
                        if (cur && Math.abs(cur[0] - target[0]) < 0.01 && Math.abs(cur[1] - target[1]) < 0.01) return;
                        other.dispatchAction?.({ type: 'dataZoom', dataZoomIndex: 0, start: target[0], end: target[1], escapeConnect: true });
                    }, inst);
                } finally {
                    st().busy = false;
                }
            },
            restore: () => {
                st().busy = true;
                try { each(apply); } finally { st().busy = false; }
            },
        };
    }, [scope]);
}

/**
 * The ONE chart card of the page: the set-point chart (per kind) above, the health score
 * below. Individual / Relation model: both are time charts on ONE time axis — the upper
 * one leaves its X labels to the lower one, the train periods are named once (above the
 * upper plot), one cursor and one zoom window serve both. Clustering: the scatter above
 * has no time axis; hovering a point (or an hour of the score chart) highlights the same
 * hour on the other.
 *
 * `score` = the hourly scores to draw, or null when there is none to draw: the lower half
 * then holds the "could not be calculated" notice (`failure`) or the lock sentence.
 */
function StackCharts({ data, props, hoverIdx, onHover, stale, unit, scopes, zoom, zoomExpanded, score, lock, lockText, failure, onRetryFailure, testNumbers }: {
    data: HealthPreview;
    props: HealthScorePageProps;
    hoverIdx: number | null;
    onHover: (i: number | null) => void;
    stale: boolean;
    unit: string;
    scopes: TimeScopes | null;
    zoom: SharedZoom;
    zoomExpanded: SharedZoom;
    score: (number | null)[] | null;
    lock: 'error' | 'bad' | 'empty';
    lockText: string;
    failure: HealthIssue | null;
    onRetryFailure?: () => void;
    testNumbers?: readonly number[] | null;
}) {
    const { model, setPoints } = props;
    const stats = data.stats;
    // The hourly points (1-hour averages): ONE index set for both charts.
    const series = data.hourly;
    // Stable until the Tag names change, so it never rebuilds a chart on its own.
    const lookup = useSensorLookup();
    const scored = !!series.score;

    const built = useMemo(() => {
        if (stats.kind === 'individual' && series.kind === 'individual') {
            return {
                title: 'Sensor value',
                what: unit || null,
                option: buildIndividualSetPointOption(series, stats, setPoints.kind === 'individual' ? setPoints : null, unit, scopes),
                time: true as const,
            };
        }
        if (stats.kind === 'relationship' && series.kind === 'relationship') {
            return {
                title: 'Residual',
                what: `actual − predicted${unit ? ` (${unit})` : ''}`,
                option: buildRelationshipSetPointOption(series, stats.two_rmse, setPoints.kind === 'relationship' ? setPoints : null, unit, scopes),
                time: true as const,
            };
        }
        if (stats.kind === 'clustering' && series.kind === 'clustering') {
            return {
                title: 'Clusters',
                what: null,
                // Axis titles: description + unit — the tags are in the subtitle.
                option: buildClusterSetPointOption(
                    series, stats.clusters, setPoints.kind === 'clustering' ? setPoints : null,
                    { x: sensorAxisTitle(lookup(model.xSensor ?? '')), y: sensorAxisTitle(lookup(model.ySensor ?? '')) }, hoverIdx,
                ),
                time: false as const,
            };
        }
        return null;
        // `hoverIdx` only changes the Clustering highlight; the time charts follow
        // the connected cursor and must not be rebuilt on every mouse move.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stats, series, setPoints, unit, model.xSensor, model.ySensor, scopes, lookup, stats.kind === 'clustering' ? hoverIdx : null]);

    const isTime = !!built?.time;
    // With the score chart under it a time chart is the UPPER half of one plot (no X labels
    // of its own); alone — the score is locked — it keeps them.
    const upperOption = useMemo(
        () => (built ? (built.time && score ? asStackUpper(built.option) : built.option) : null),
        [built, score],
    );
    // Under a time chart the periods are already named; under the scatter the strip is its own.
    const lowerOption = useMemo(() => {
        if (!score) return null;
        const option = buildScoreOption(series.timestamps, score, scopes);
        return isTime ? asStackLower(option) : option;
    }, [series.timestamps, score, scopes, isTime]);

    // A new option redraws a chart unzoomed: put the shared window back (on the page, and
    // in the enlarged copy when it is open).
    useEffect(() => {
        if (!isTime && !lowerOption) return;
        zoom.restore();
        zoomExpanded.restore();
    }, [upperOption, lowerOption, isTime, zoom, zoomExpanded]);

    if (!built || !upperOption) return null;

    const text = readoutText(readoutAt(series, hoverIdx), unit);
    // The subtitle says what the upper chart plots, that every point of BOTH charts is a
    // 1-hour average of the running rows, and (time charts) that they share the axis.
    const sub = built.time ? (
        <>
            {built.what && <>{built.what} · </>}
            <span data-testid="score-basis">1-hour averages of the running rows</span>
            {' '}· one time axis, one cursor for both
        </>
    ) : (
        <span className="wb2-sub-sl">
            <SensorInline tag={model.xSensor ?? ''} size="sm" muted /> vs <SensorInline tag={model.ySensor ?? ''} size="sm" muted />
            {' '}<span className="wb2-sub-note">· <span data-testid="score-basis">1-hour averages of the running rows</span> · {scored ? 'coloured by score' : 'coloured by score once N is set'}</span>
        </span>
    );

    // No key row under these charts: the time charts only zoom in time, so the names of
    // their level lines stay at the right edge; the Clusters chart zooms on both axes,
    // but its rings are keyed by the score ruler above it (1× / 3× / N× SD in the rings'
    // colours).
    const body = (expanded: boolean) => {
        // The enlarged copy is a pair of its own: its own cursor group and zoom window.
        const z = expanded ? zoomExpanded : zoom;
        const timeProps: Partial<ComponentProps<typeof ResponsiveECharts>> = {
            onChartReady: z.join,
            onEvents: {
                updateAxisPointer: (e: unknown) => onHover(hoverIndexFromAxisEvent(e, series.timestamps)),
                globalout: () => onHover(null),
                datazoom: z.onZoom,
            },
        };
        const upperProps: Partial<ComponentProps<typeof ResponsiveECharts>> = built.time ? timeProps : {
            onEvents: {
                mouseover: (p: { seriesName?: string; dataIndex?: number }) => { if (p.seriesName === 'Points' && typeof p.dataIndex === 'number') onHover(p.dataIndex); },
                globalout: () => onHover(null),
            },
        };
        // The test ids name the halves of the card ON THE PAGE; the enlarged copy has none
        // (it would repeat them).
        const id = (name: string) => (expanded ? undefined : name);
        return (
            <div className={`wb3-stack-in${built.time ? '' : ' wb3-stack-in--xy'}`} data-testid={id('chart-stack')} data-upper={stats.kind}>
                <div className="wb3-stack-top" data-testid={id(`chart-card-set-${stats.kind}`)}>
                    <ResponsiveECharts option={upperOption} style={{ height: '100%', minHeight: 0 }} {...upperProps} />
                </div>
                {lowerOption ? (
                    <div className="wb3-stack-bot" data-testid={id('chart-card-score')}>
                        <ResponsiveECharts option={lowerOption} style={{ height: '100%', minHeight: 0 }} {...timeProps} />
                    </div>
                ) : failure ? (
                    <div className="wb3-stack-bot wb3-stack-bot--lock" data-testid={id('score-failed')}>
                        <TestScoringFailedNotice issue={failure} onRetry={onRetryFailure} testNumbers={testNumbers} />
                    </div>
                ) : (
                    <div className="wb3-stack-bot wb3-stack-bot--lock" data-testid={id('score-locked')} data-lock={lock}>
                        <div className="wb3-stack-locktext">
                            {lock === 'error' ? <><b>Score not available</b>Not available until the health score loads.</> : lockText}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <ChartCard
            id="stack"
            title={`${built.title} and health score`}
            sub={sub}
            full
            size={built.time ? 'stack' : 'stackxy'}
            stale={stale}
            extra={<span className="hs-rd" data-testid="hs-readout">{text}</span>}
            render={body}
        />
    );
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

/** A share of the scored hours as text: one decimal, and a share that is not zero never
 *  reads "0.0%" (it is "< 0.1%"). Every share on the page uses this rule. */
export function shareText(v: number): string {
    return v > 0 && v < 0.1 ? '< 0.1%' : `${v.toFixed(1)}%`;
}

/** The three score bands, in the order of the bar (best first), in the app's score colours. */
const SHARES: { key: 'share_80_100' | 'share_40_80' | 'share_0_40'; label: string; color: string }[] = [
    { key: 'share_80_100', label: '80–100', color: 'var(--ok)' },
    { key: 'share_40_80', label: '40–80', color: 'var(--warn)' },
    { key: 'share_0_40', label: '0–40', color: 'var(--danger)' },
];

/** What the tiles show: the score (`ready`), nothing yet because the set points are not
 *  valid (`locked`), or nothing because the health score did not load (`error`). */
export type ScoreKpiState = 'ready' | 'locked' | 'error';

/** The caption of a tile that has no number to show. */
const NOT_LOADED = 'not available until the score loads';

/**
 * The KPI strip of the Health score page: `Lowest score · Below 80 · Share of scored
 * hours`, for ALL scored hours (there is never a tile per scoring period — user decision
 * 2026-10-12). Tiles do not judge: the only colour is on a number that IS a score — the
 * lowest score (green from 80, red below) — and the bar's three score bands.
 * `summary` is null whenever there is no score to show (`state` says why).
 */
export function ScoreKpis({ summary, state }: { summary: ScoreSummary | null | undefined; state: ScoreKpiState }) {
    const ready = state === 'ready' && !!summary;
    const lowest = ready ? summary.min_score : null;
    const pct = ready ? summary.pct_below_80 : null;
    const scored = ready ? summary.scored : 0;
    const waiting = state === 'error' ? NOT_LOADED : 'once the set points are valid';
    return (
        <KpiStrip scroll testId="score-summary" state={state}>
            <Kpi
                label="Lowest score"
                testId="kpi-lowest"
                // Coloured by the band its score is in — the same three bands as the score
                // chart's line and the share bar: 80–100, 40–80, below 40 (SPEC §6).
                tone={lowest ? (lowest.score >= 80 ? 'ok' : lowest.score >= 40 ? 'warn' : 'bad') : undefined}
                value={lowest ? <span data-testid="score-lowest">{Math.round(lowest.score)}</span> : '—'}
                sub={lowest
                    // The hour start in the app's one date format; every score is a 1-hour average.
                    ? <>{lowest.timestamp && <>on <span className="wbx-dt" data-testid="score-lowest-at">{formatDataStamp(lowest.timestamp)}</span> · </>}1 h average</>
                    : ready ? 'no scored hours' : waiting}
            />
            <Kpi
                label="Below 80"
                testId="kpi-below80"
                value={pct !== null ? <span data-testid="score-below80">{shareText(pct)}</span> : '—'}
                sub={ready ? `of ${scored.toLocaleString('en-US')} scored hour${scored === 1 ? '' : 's'}` : state === 'error' ? NOT_LOADED : 'of the scored hours'}
            />
            <Kpi
                label="Share of scored hours"
                testId="score-shares"
                small
                value={
                    <span className="wb3-sharebar" role="img" aria-label="Share of scored hours by score band" data-testid="share-bar">
                        {SHARES.map(s => {
                            const v = ready ? summary[s.key] : null;
                            // A band that has hours is always visible, however small its share.
                            return v ? <i key={s.key} data-band={s.key} style={{ flexGrow: v, background: s.color }} /> : null;
                        })}
                    </span>
                }
                sub={state === 'error' ? NOT_LOADED : undefined}
            >
                <div className="wb3-sharekey">
                    {SHARES.map(s => {
                        const v = ready ? summary[s.key] : null;
                        return (
                            <span key={s.key} data-testid={`share-${s.key}`}>
                                <i style={{ background: s.color }} /><span>{s.label}</span><b>{v === null ? '—' : shareText(v)}</b>
                            </span>
                        );
                    })}
                </div>
            </Kpi>
        </KpiStrip>
    );
}

export default memo(HealthScorePage, sameHealthScoreProps);
