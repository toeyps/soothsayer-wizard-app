import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { samePageProps } from './pageMemo';
import { connect } from 'echarts';
import { Loader2 } from 'lucide-react';
import ResponsiveECharts from '../../charts/ResponsiveECharts';
import type { HealthIssue, HealthPreview, ScoreSummary } from '../../../types/health';
import { PairSub } from './PairSub';
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
    buildHealthFitOption,
    buildClusterSetPointOption,
    buildIndividualSetPointOption,
    buildRelationshipSetPointOption,
    buildScoreOption,
} from './healthPageCharts';
import { clusterChartNames, hourlyScopes, scopesOf, type TimeScopes } from './healthCharts';
import { formatDataStamp } from '../periodDisplay';
import { SlowScoringNotice, TestScoringFailedNotice, TestsChangedBanner } from './ValidationCards';
import { testScoringFailure } from '../../../utils/trainTestValidation';
import { FitGoneBoard, LoadFailedBoard, StateBoard, TrainSensorLink } from './WorkbenchShellParts';
import type { HealthScorePageProps, SaveInfo } from './workbenchTypes';

/* Health score page body: KPI tiles, set-point ruler + Checks, and one card of two stacked charts sharing one time axis, cursor and zoom. Drawn from the bounded `HealthPreview` of the DRAFT set points; numbers read `data.hourly` (1-hour averages), never `data.series`. */

/** Memo comparison: the small data rebuilt per render is compared by value, the rest by identity (callbacks must be stable). */
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

/** A Mark complete check running this long gets a line on the page. */
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
    // One zoom window for the two time charts and one for their Expand copy. Hooks: must stay above the early returns.
    const zoom = useSharedZoom(props.model.id);
    const zoomExpanded = useSharedZoom(props.model.id, 'expanded');
    // A failed request keeps the page up from `lastData` under a red Retry card.
    // A Relation fit gone from memory (NOT_FITTED) has its own board (`preview.notFitted` or `fitGone.gone`).
    const fitIsGone = preview.notFitted || !!props.fitGone.gone;
    const failed = !preview.data && !fitIsGone && !!preview.error;
    // After a failure the next request clears `error` while `data` is null; stay on the page or the typed input unmounts.
    const asking = !preview.data && !preview.error && preview.loading && !!preview.lastData;
    // The page is drawn from the last good answer, which does not describe what is typed.
    const errorMode = (failed || asking) && !!preview.lastData;
    const data = preview.data ?? (errorMode ? preview.lastData ?? null : null);
    // Train/scoring scopes of the time charts (null = none sent); memoised so hover re-renders don't rebuild the charts.
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
    // One failure card (with or without an earlier answer): reason and Retry. Mark complete is disabled meanwhile.
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
        // The model's own load/train failed: no preview is asked for, or the page would read Loading forever.
        const loadError = !fitIsGone && !props.fitLoading ? props.fitGone.error ?? null : null;
        const kindName = model.kind === 'relationship' ? 'Relation model' : `${model.kind === 'clustering' ? 'Clustering' : 'Individual'} model`;
        return (
            <div className="wb2-board" data-testid="health-page">
                <SaveBanner save={save} slow={slowSave} />
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
                    // Fit being loaded again: say so. Otherwise one board: 'Load it again', or 'Train sensor ↑' when it trains this model.
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

    // While an error shows, the old verdict/issues/score don't describe the typed set points: nothing is judged.
    const issues = errorMode ? [] : attemptIssues ?? data.validation;
    const verdict = errorMode ? null : attemptIssues ? verdictOfIssues(attemptIssues) ?? healthVerdict(data) : healthVerdict(data);
    const scoreReady = !errorMode && data.valid && !!data.hourly.score && !!data.score_summary;
    // 'Could not be calculated' (no answer for the hours to score): replaces the score chart if no hour scored, else a card above the charts.
    const scoringFailure = errorMode ? null : testScoringFailure(data);
    const anyScored = !!data.hourly.score?.some(v => v !== null);
    const retryScoring = canRetry ? (props.onRetryTestScoring ?? props.onRetryPreview) : undefined;
    // Draw the score chart only when there is a score and not after a failure that scored no hour.
    const score = scoreReady && data.hourly.score && !(scoringFailure && !anyScored) ? data.hourly.score : null;

    return (
        <div className="wb2-board hs-board" data-testid="health-page" data-valid={String(data.valid)}>
            {/* The page's numbers first, as tiles. */}
            <ScoreKpis summary={scoreReady ? data.score_summary : null} state={errorMode ? 'error' : scoreReady ? 'ready' : 'locked'} />
            <SaveBanner save={save} slow={slowSave} />
            <SlowScoringNotice show={props.slowScoring} />
            {errorCard}
            <TestsChangedBanner state={props.testsChanged} />
            {/* Ruler card: value to score in one band, footnote, then the Checks. */}
            <ScoreRuler
                data={data}
                setPoints={setPoints}
                unit={unit}
                issues={issues}
                verdict={verdict}
                unchecked={errorMode}
                onChange={props.onSetPointsChange}
                onCommit={props.onSetPointsCommit}
                disabledReason={props.setPointsDisabledReason ?? null}
            >
                <ChecksCard kind={data.kind} issues={issues} verdict={verdict} unavailable={errorMode} testNumbers={testNumbers} />
            </ScoreRuler>
            {scoringFailure && score && (
                <section className="hs-card hs-full" data-testid="score-failed">
                    <div className="wb2-card-h"><b>Health score</b></div>
                    <TestScoringFailedNotice issue={scoringFailure} onRetry={retryScoring} testNumbers={testNumbers} />
                </section>
            )}
            {/* One card, two charts; time charts share axis, cursor and zoom. Clustering: hovering an hour highlights it on the other chart. */}
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

/** Why the score area is locked: request failed, a set point rejected, or nothing to draw yet. */
export function lockReason(errorMode: boolean, verdict: HealthVerdict | null): 'error' | 'bad' | 'empty' {
    return errorMode ? 'error' : verdict === 'bad' ? 'bad' : 'empty';
}

/** Locked-area sentence: sends the user to the ruler to fix or set points. */
export function scoreLockText(verdict: HealthVerdict | null): string {
    return verdict === 'bad'
        ? 'Fix the set point on the ruler above — the score appears here'
        : 'Set every point on the ruler above — the score appears here';
}

// Failed Mark complete, and a slow check. Checking otherwise shows only in the notice line.

function SaveBanner({ save, slow }: { save: SaveInfo; slow: boolean }) {
    if (save.phase === 'running' && slow) {
        return (
            <div className="hs-save hs-full" role="status" data-testid="save-running">
                <Loader2 size={14} className="pm-spin" aria-hidden="true" />
                <span>
                    <b>Still checking…</b> Checking the model is taking longer than usual.
                </span>
            </div>
        );
    }
    if (save.phase !== 'error') return null;
    // The reason is the failure message of the save.
    return (
        <div className="hs-save hs-save--bad hs-full" role="alert" data-testid="save-error">
            <span><b>The model was not saved.</b> <span data-testid="save-error-reason">{save.message}</span></span>
        </div>
    );
}


/** Which chart pair a `useSharedZoom` serves: the page's, or the Expand overlay's copy. */
export type ZoomScope = 'page' | 'expanded';

/** Join the ECharts group for a shared cursor. The page pair and the Expand copy are separate groups; a chart joins only its own. */
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

/** Shared zoom window for the stacked time charts, kept here so a chart redrawn from a new option (which starts unzoomed) gets it back. `scope` picks the page pair or the Expand copy (separate cursor group and window). */
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
                // The Expand copy opens on the full range every time: once its old charts are disposed, drop the window.
                if (scope === 'expanded') {
                    for (const old of [...st().charts]) if (old.isDisposed?.()) st().charts.delete(old);
                    if (st().charts.size === 0) st().win = null;
                }
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

/** The page's one chart card: set-point chart above, health score below. Time charts share axis, cursor and zoom. `score` null = the lower half shows the failure notice or the lock sentence. */
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
                title: 'Actual vs predicted, residual',
                what: `residual = actual − predicted${unit ? ` (${unit})` : ''}`,
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
                    clusterChartNames(lookup(model.xSensor ?? ''), lookup(model.ySensor ?? '')), hoverIdx,
                ),
                time: false as const,
            };
        }
        return null;
        // `hoverIdx` only changes the Clustering highlight; time charts follow the connected cursor and must not rebuild on every mouse move.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stats, series, setPoints, unit, model.xSensor, model.ySensor, scopes, lookup, stats.kind === 'clustering' ? hoverIdx : null]);

    const isTime = !!built?.time;
    // Relation model: Actual and Predicted above the residual (their difference); train periods named once above the stack.
    const fitOption = useMemo(
        () => (stats.kind === 'relationship' && series.kind === 'relationship' ? asStackUpper(buildHealthFitOption(series, unit, scopes)) : null),
        [stats.kind, series, unit, scopes],
    );
    // With the score chart below, a time chart is the upper half (no X labels); alone (score locked) it keeps them.
    const upperOption = useMemo(() => {
        if (!built) return null;
        if (!built.time) return built.option;
        const option = fitOption ? asStackLower(built.option) : built.option;
        return score ? asStackUpper(option) : option;
    }, [built, fitOption, score]);
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
    }, [fitOption, upperOption, lowerOption, isTime, zoom, zoomExpanded]);

    // Make handlers once, reading the latest values via refs: a new `onEvents` per render makes echarts-for-react rebind without unbinding.
    const hoverRef = useRef(onHover);
    hoverRef.current = onHover;
    const stampsRef = useRef(series.timestamps);
    stampsRef.current = series.timestamps;
    const chartEvents = useMemo(() => {
        const time = (z: SharedZoom) => ({
            updateAxisPointer: (e: unknown) => hoverRef.current(hoverIndexFromAxisEvent(e, stampsRef.current)),
            globalout: () => hoverRef.current(null),
            datazoom: z.onZoom,
        });
        return {
            page: time(zoom),
            expanded: time(zoomExpanded),
            // Clustering's scatter: hovering a point highlights its hour on the score chart.
            scatter: {
                mouseover: (p: { seriesName?: string; dataIndex?: number }) => { if (p.seriesName === 'Points' && typeof p.dataIndex === 'number') hoverRef.current(p.dataIndex); },
                globalout: () => hoverRef.current(null),
            },
        };
    }, [zoom, zoomExpanded]);

    if (!built || !upperOption) return null;

    const text = readoutText(readoutAt(series, hoverIdx), unit);
    // Subtitle: what the upper chart plots, the 1-hour averages of running rows, and (time charts) the shared axis.
    const sub = built.time ? (
        <>
            {built.what && <>{built.what} · </>}
            <span data-testid="score-basis">1-hour averages of the running rows</span>
            {' '}· one time axis, one cursor for {fitOption ? 'all' : 'both'}
        </>
    ) : (
        <PairSub
            x={model.xSensor ?? ''}
            y={model.ySensor ?? ''}
            note={<>· <span data-testid="score-basis">1-hour averages of the running rows</span> · {scored ? 'coloured by score' : 'coloured by score once N is set'}</>}
        />
    );

    // No key row: level lines are named at the right edge; Clusters rings are keyed by the score ruler.
    const body = (expanded: boolean) => {
        // The enlarged copy is a pair of its own: its own cursor group and zoom window.
        const z = expanded ? zoomExpanded : zoom;
        const timeProps: Partial<ComponentProps<typeof ResponsiveECharts>> = {
            onChartReady: z.join,
            onEvents: expanded ? chartEvents.expanded : chartEvents.page,
        };
        const upperProps: Partial<ComponentProps<typeof ResponsiveECharts>> = built.time ? timeProps : { onEvents: chartEvents.scatter };
        // The test ids name the halves of the card ON THE PAGE; the enlarged copy has none
        // (it would repeat them).
        const id = (name: string) => (expanded ? undefined : name);
        return (
            <div className={`wb3-stack-in${built.time ? '' : ' wb3-stack-in--xy'}${fitOption ? ' wb3-stack-in--fit' : ''}`} data-testid={id('chart-stack')} data-upper={stats.kind}>
                {fitOption && (
                    <div className="wb3-stack-fit" data-testid={id('chart-card-fit')}>
                        <ResponsiveECharts option={fitOption} style={{ height: '100%', minHeight: 0 }} {...timeProps} />
                    </div>
                )}
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
            size={fitOption ? 'stack3' : built.time ? 'stack' : 'stackxy'}
            stale={stale}
            extra={<span className="hs-rd" data-testid="hs-readout">{text}</span>}
            render={body}
        />
    );
}


/** Share of scored hours as text: one decimal; a nonzero share never reads '0.0%' (it is '< 0.1%'). */
export function shareText(v: number): string {
    return v > 0 && v < 0.1 ? '< 0.1%' : `${v.toFixed(1)}%`;
}

/** The three score bands, in the order of the bar (best first), in the app's score colours. */
const SHARES: { key: 'share_80_100' | 'share_40_80' | 'share_0_40'; label: string; color: string }[] = [
    { key: 'share_80_100', label: '80–100', color: 'var(--ok)' },
    { key: 'share_40_80', label: '40–80', color: 'var(--warn)' },
    { key: 'share_0_40', label: '0–40', color: 'var(--danger)' },
];

/** KPI tile state: score shown (`ready`), set points invalid (`locked`), or score failed to load (`error`). */
export type ScoreKpiState = 'ready' | 'locked' | 'error';

/** The caption of a tile that has no number to show. */
const NOT_LOADED = 'not available until the score loads';

/** KPI strip for ALL scored hours. Only the lowest score is coloured (ok from 80, warn from 40, else bad); `summary` null = nothing to show. */
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
                // Same three bands as the score chart and share bar: 80-100, 40-80, below 40.
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
