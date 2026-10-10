import { memo, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { samePageProps } from './pageMemo';
import { connect } from 'echarts';
import { Loader2 } from 'lucide-react';
import ResponsiveECharts from '../../charts/ResponsiveECharts';
import type { HealthPreview, ScoreSummary } from '../../../types/health';
import { SensorInline } from '../../sensor/SensorLabel';
import { useSensorLookup } from '../../sensor/sensorInfo';
import ChartCard from './ChartCard';
import ChecksCard from './ChecksCard';
import SetPointsCard from './SetPointsCard';
import { CHART } from './chartTheme';
import {
    healthVerdict,
    hoverIndexFromAxisEvent,
    readoutAt,
    readoutText,
    verdictOfIssues,
} from './healthChecks';
import {
    HEALTH_SYNC_GROUP,
    buildClusterSetPointOption,
    buildIndividualSetPointOption,
    buildRelationshipSetPointOption,
    buildScoreOption,
} from './healthPageCharts';
import { scopesOf, sensorAxisTitle, type TimeScopes } from './healthCharts';
import { formatDataStamp } from '../periodDisplay';
import { SlowScoringNotice, TestResultsCard, TestsChangedBanner } from './ValidationCards';
import { StateBoard, TrainSensorLink } from './WorkbenchShellParts';
import type { HealthScorePageProps, SaveInfo } from './workbenchTypes';

/*
 * Page 2 of the Workbench - "Health score" body (mockup `healthPage`):
 *
 *   [ set-point chart (tall)        ] [ Health set points: table  ]
 *   [                               ] [ + footnote + the Checks   ]
 *   [ Health score over time (full width, locked until valid)     ]
 *
 * Everything is drawn from the ONE bounded `HealthPreview` the container's
 * `useHealthPreview` returns for the DRAFT set points (so typing moves the
 * lines, the score and the Checks within ~250 ms). The footer (<- Model fit,
 * status, Mark complete) is rendered by the container, because Mark complete
 * shares its persist flow.
 *
 * Hover: the two time charts (Individual / Relationship) are connected in one
 * ECharts group, so one timestamp cursor shows on both; the page ALSO keeps the
 * hovered series index to print "time - value - score" next to the score
 * chart's title. Clustering has no time axis on its set-point chart, so hovering
 * a point there (or the score chart) highlights the same row on the other.
 *
 * No legend rows (workbench-redesign SPEC §3): every line is labelled on its
 * chart — reference lines at the right edge, the user's set points with their
 * typed value, the ring levels at the ring's edge — and the score bands are read
 * off the share column beside the score chart.
 */

/** Memo comparison (see `samePageProps`): the small data the window rebuilds per
 *  render (model, set points, save record, tests-changed state, scoring-period numbers)
 *  by value, everything else by identity — the callbacks must be stable. */
export function sameHealthScoreProps(a: HealthScorePageProps, b: HealthScorePageProps): boolean {
    return samePageProps(a, b, ['model', 'setPoints', 'save', 'testsChanged', 'testNumbers', 'attemptIssues']);
}

/** A save that has been running this long gets a line on the page; until then
 *  the footer sentence ("Saving the model files…") says it alone (SPEC §4). */
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
    // A failed request leaves `preview.data` null, but when an earlier answer for this
    // model exists the page (inputs, charts) stays on screen from `lastData` under the
    // red card with its Retry instead of being replaced (QA fix, 2026-10-04).
    // A Relation-model fit that is gone from memory (NOT_FITTED) has its own board.
    const failed = !preview.data && !preview.notFitted && !!preview.error;
    const errorMode = failed && !!preview.lastData;
    const data = preview.data ?? (errorMode ? preview.lastData ?? null : null);
    // Train / scoring scopes on the time charts (null = no scoring periods sent).
    // Memoised on the payload so a hover re-render never rebuilds the time charts.
    const validation = data?.test_validation;
    // S-numbers of the sent scoring periods: memoised on their VALUE (the container
    // builds a new array every render).
    const testNumbers = props.testNumbers;
    const numbersKey = testNumbers ? testNumbers.join(',') : '';
    const scopes = useMemo(
        () => scopesOf(validation, numbersKey ? numbersKey.split(',').map(Number) : null),
        [validation, numbersKey],
    );
    const slowSave = useHeldFor(save.phase === 'running', SLOW_SAVE_NOTICE_MS);
    // A new request cannot be fixed by asking again after the dataset changed.
    const canRetry = !!props.onRetryPreview && preview.errorCode !== 'STALE_SESSION';
    // The ONE shape of "the preview failed" (SPEC §4), with or without an earlier
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
    ) : null;
    const goTrain = (testId: string) => <TrainSensorLink testId={testId} onClick={props.onGoTrainSensor} />;

    if (!data) {
        return (
            <div className="wb2-board" data-testid="health-page">
                <SaveBanner save={save} slow={slowSave} relation={model.kind === 'relationship'} />
                <SlowScoringNotice show={props.slowScoring} />
                {errorCard}
                {preview.notFitted ? (
                    // No Re-train button here: the board points at the one place to train.
                    <StateBoard
                        testId="health-not-fitted"
                        className="hs-full hs-stateboard"
                        title="Fit no longer in memory"
                        text={<>The fitted Relation model is no longer in memory (the data was reloaded or a special sensor changed). Re-train it with {goTrain('health-go-train-sensor')} — your set points are kept and scored again when it finishes.</>}
                    />
                ) : !failed && (
                    <StateBoard
                        testId="health-loading"
                        className="hs-full hs-stateboard"
                        tone="run"
                        title={`Loading the ${model.kind === 'relationship' ? 'Relation model' : `${model.kind === 'clustering' ? 'Clustering' : 'Individual'} model`}…`}
                        text="The set points and the score appear here when it is ready."
                    />
                )}
            </div>
        );
    }

    // While an error shows, the old answer's verdict / issues / score do not describe the set
    // points on screen: nothing is judged until the next request lands.
    const issues = errorMode ? [] : attemptIssues ?? data.validation;
    const verdict = errorMode ? null : attemptIssues ? verdictOfIssues(attemptIssues) ?? healthVerdict(data) : healthVerdict(data);
    const scoreReady = !errorMode && data.valid && !!data.series.score && !!data.score_summary;

    return (
        <div className="wb2-board wb2-hs hs-board" data-testid="health-page" data-valid={String(data.valid)}>
            <SaveBanner save={save} slow={slowSave} relation={model.kind === 'relationship'} />
            <SlowScoringNotice show={props.slowScoring} />
            {errorCard}
            <TestsChangedBanner state={props.testsChanged} />
            {preview.notFitted && (
                <div className="wb2-stale hs-full" role="status" data-testid="health-not-fitted-banner">
                    <span><b>Fit no longer in memory.</b> The chart below is the last result. Re-train the Relation model with {goTrain('health-go-train-sensor')} — your set points are kept.</span>
                </div>
            )}
            <SetPointChart
                data={data}
                props={props}
                hoverIdx={hoverIdx}
                onHover={setHoverIdx}
                stale={stale}
                unit={unit}
                scopes={scopes}
            />
            <div className="hs-spp">
                {/* ONE card: the table of set points, its footnote, then the Checks. */}
                <SetPointsCard
                    data={data}
                    setPoints={setPoints}
                    unit={unit}
                    issues={issues}
                    verdict={verdict}
                    onChange={props.onSetPointsChange}
                    onCommit={props.onSetPointsCommit}
                >
                    <ChecksCard kind={data.kind} issues={issues} verdict={verdict} unavailable={errorMode} />
                </SetPointsCard>
            </div>
            {/* "Changed after saving" is said ONCE — the footer sentence, next to its
                "Mark complete again" button (SPEC workbench-redesign §1). */}
            {scoreReady && data.series.score && data.score_summary ? (
                <ScoreChart
                    data={data}
                    score={data.series.score}
                    summary={data.score_summary}
                    unit={unit}
                    hoverIdx={hoverIdx}
                    onHover={setHoverIdx}
                    stale={stale}
                    scopes={scopes}
                />
            ) : (
                <section className="hs-card hs-full" data-testid="score-locked">
                    <div className="wb2-card-h"><b>Health score</b></div>
                    <div className="hs-lockbig">
                        <div>{errorMode ? <><b>Score not available</b>Not available until the health score loads.</> : <><b>Set the points above</b>The score over time appears here once every set point is valid.</>}</div>
                    </div>
                </section>
            )}
            <TestResultsCard data={data} scoreReady={scoreReady} unavailable={errorMode} custom={model.runningConditionMode === 'custom'} testNumbers={testNumbers} onRetry={canRetry ? (props.onRetryTestScoring ?? props.onRetryPreview) : undefined} />
        </div>
    );
}

// ---------------------------------------------------------------------------
// A FAILED save, and a save that is taking long. Saving is otherwise said by the
// footer alone ("Saving the model files…" next to its button), and a successful
// save is the footer sentence too ("Files saved 9 Feb 2026 23:50 · …\output\TAG";
// SPEC workbench-redesign §1 / §4).
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
// Set-point chart (per kind)
// ---------------------------------------------------------------------------

/** Join the ECharts group so the pair of time charts share one cursor. */
function joinSyncGroup(inst: { group?: string } | null | undefined) {
    if (!inst) return;
    try {
        inst.group = HEALTH_SYNC_GROUP;
        connect(HEALTH_SYNC_GROUP);
    } catch {
        // No sync is not worth breaking the page for.
    }
}

function SetPointChart({ data, props, hoverIdx, onHover, stale, unit, scopes }: {
    data: HealthPreview;
    props: HealthScorePageProps;
    hoverIdx: number | null;
    onHover: (i: number | null) => void;
    stale: boolean;
    unit: string;
    scopes: TimeScopes | null;
}) {
    const { model, setPoints } = props;
    const stats = data.stats;
    const series = data.series;
    // Stable until the Tag names change, so it never rebuilds a chart on its own.
    const lookup = useSensorLookup();
    const scored = !!series.score;

    const built = useMemo(() => {
        if (stats.kind === 'individual' && series.kind === 'individual') {
            return {
                id: 'set-individual',
                title: 'Sensor value over time',
                sub: unit || undefined,
                option: buildIndividualSetPointOption(series, stats, setPoints.kind === 'individual' ? setPoints : null, unit, scopes),
                time: true,
            };
        }
        if (stats.kind === 'relationship' && series.kind === 'relationship') {
            return {
                id: 'set-relationship',
                title: 'Residual over time',
                sub: `actual − predicted${unit ? ` (${unit})` : ''}`,
                option: buildRelationshipSetPointOption(series, stats.two_rmse, setPoints.kind === 'relationship' ? setPoints : null, unit, scopes),
                time: true,
            };
        }
        if (stats.kind === 'clustering' && series.kind === 'clustering') {
            return {
                id: 'set-clustering',
                title: 'Clusters',
                sub: (
                    <span className="wb2-sub-sl">
                        <SensorInline tag={model.xSensor ?? ''} size="sm" muted /> vs <SensorInline tag={model.ySensor ?? ''} size="sm" muted />
                        {' '}<span className="wb2-sub-note">· {scored ? 'points coloured by score' : 'coloured by score once N is set'}</span>
                    </span>
                ),
                // Axis titles: description + unit — the tags are in the subtitle above.
                option: buildClusterSetPointOption(
                    series, stats.clusters, setPoints.kind === 'clustering' ? setPoints : null,
                    { x: sensorAxisTitle(lookup(model.xSensor ?? '')), y: sensorAxisTitle(lookup(model.ySensor ?? '')) }, hoverIdx,
                ),
                time: false,
            };
        }
        return null;
        // `hoverIdx` only changes the Clustering highlight; the time charts follow
        // the connected cursor and must not be rebuilt on every mouse move.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stats, series, setPoints, unit, model.xSensor, model.ySensor, scopes, lookup, scored, stats.kind === 'clustering' ? hoverIdx : null]);

    if (!built) return null;

    const chartProps: Partial<ComponentProps<typeof ResponsiveECharts>> = built.time
        ? {
            onChartReady: joinSyncGroup,
            onEvents: {
                updateAxisPointer: (e: unknown) => onHover(hoverIndexFromAxisEvent(e, series.timestamps)),
                globalout: () => onHover(null),
            },
        }
        : {
            onEvents: {
                mouseover: (p: { seriesName?: string; dataIndex?: number }) => { if (p.seriesName === 'Points' && typeof p.dataIndex === 'number') onHover(p.dataIndex); },
                globalout: () => onHover(null),
            },
        };

    return (
        <div className="hs-setwrap">
            <ChartCard
                id={built.id}
                title={built.title}
                sub={built.sub}
                size="tall"
                stale={stale}
                option={built.option}
                chartProps={chartProps}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Score chart
// ---------------------------------------------------------------------------

const SHARES: { key: 'share_80_100' | 'share_40_80' | 'share_0_40'; label: string; color: string }[] = [
    { key: 'share_80_100', label: '80–100', color: CHART.ok },
    { key: 'share_40_80', label: '40–80', color: CHART.warn },
    { key: 'share_0_40', label: '0–40', color: CHART.danger },
];

function ScoreChart({ data, score, summary, unit, hoverIdx, onHover, stale, scopes }: {
    data: HealthPreview;
    score: (number | null)[];
    summary: ScoreSummary;
    unit: string;
    hoverIdx: number | null;
    onHover: (i: number | null) => void;
    stale: boolean;
    scopes: TimeScopes | null;
}) {
    const series = data.series;
    const option = useMemo(() => buildScoreOption(series.timestamps, score, scopes), [series.timestamps, score, scopes]);
    const lowest = summary.min_score;
    const text = readoutText(readoutAt(series, hoverIdx), unit);
    const chartProps = {
        onChartReady: joinSyncGroup,
        onEvents: {
            updateAxisPointer: (e: unknown) => onHover(hoverIndexFromAxisEvent(e, series.timestamps)),
            globalout: () => onHover(null),
        },
    };
    const pct = summary.pct_below_80;
    return (
        <ChartCard
            id="score"
            title="Health score"
            full
            size="hs"
            stale={stale}
            sub={
                <span data-testid="score-summary">
                    {lowest ? <>Lowest <b className={lowest.score >= 80 ? 'hs-good' : 'hs-bad'} data-testid="score-lowest">{Math.round(lowest.score)}</b>{lowest.timestamp ? <> on <span className="wbx-dt" data-testid="score-lowest-at">{formatDataStamp(lowest.timestamp)}</span></> : ''}</> : 'No scored rows'}
                    {pct !== null && <> · below 80 for <b data-testid="score-below80">{pct.toFixed(1)}%</b> of scored rows</>}
                </span>
            }
            extra={<span className="hs-rd" data-testid="hs-readout">{text}</span>}
            render={() => (
                <div className="hs-scorewrap">
                    <div className="hs-scorechart">
                        <ResponsiveECharts option={option} style={{ height: '100%', minHeight: 0 }} {...chartProps} />
                    </div>
                    <div className="hs-shares" data-testid="score-shares">
                        <div className="hs-shares-h">Share of scored rows</div>
                        {SHARES.map(s => {
                            const v = summary[s.key];
                            return (
                                <div key={s.key} className="hs-share" data-testid={`share-${s.key}`}>
                                    <span className="hs-share-l">{s.label}</span>
                                    <span className="hs-share-bar"><i style={{ width: `${Math.max(v === null ? 0 : v, v ? 1 : 0)}%`, background: s.color }} /></span>
                                    {/* A share that is not zero never reads "0.0%". */}
                                    <span className="hs-share-v">{v === null ? '—' : v > 0 && v < 0.1 ? '< 0.1%' : `${v.toFixed(1)}%`}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        />
    );
}

export default memo(HealthScorePage, sameHealthScoreProps);
