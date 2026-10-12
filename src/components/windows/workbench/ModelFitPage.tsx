import { memo } from 'react';
import { samePageProps } from './pageMemo';
import { LayoutGrid } from 'lucide-react';
import { SensorPickerSingle } from '../../sensor/SensorPicker';
import { SensorInline } from '../../sensor/SensorLabel';
import { useSensorLookup } from '../../sensor/sensorInfo';
import type { HealthPreview } from '../../../types/health';
import ChartCard, { LegendItem } from './ChartCard';
import { CHART, fmtNum } from './chartTheme';
import {
    buildClusterOption,
    buildDistributionOption,
    buildFitScatterOption,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildValueOverTimeOption,
    compactScopes,
    estimateRowsOutside3sd,
    individualVLines,
    scopesOf,
    sensorAxisTitle,
} from './healthCharts';
import { SlowScoringNotice, TrainDaysNotice } from './ValidationCards';
import type { WorkbenchPageProps } from './workbenchTypes';
import { Kpi, KpiStrip } from './Kpi';
import { shareText } from './HealthScorePage';

/*
 * Page 1 of the Workbench — "Model fit" body: the numbers
 * and charts of the TRAINED model, per kind. Everything comes from the
 * bounded `HealthPreview` Rust returns (`useHealthPreview`), never from row
 * arrays.
 *
 * Every kind opens with a strip of three KPI tiles (`KpiStrip` / `Kpi`,
 * "Workbench detail pages v2" SPEC §5), then its charts:
 *
 *   Individual   tiles Mean · SD · Outside ±3SD, then Sensor value over time
 *                (±1SD/±3SD) and Distribution, both full width
 *   Relationship tiles R² · RMSE · Residual SD, then Fit (+ X selector, Compare
 *                predictors) · Target vs predicted · Residual over time (±2RMSE)
 *                (no residual distribution, no side histogram — by design)
 *   Clustering   tiles Clusters · In a cluster · Inside 3× SD, then the scatter +
 *                1×/3× SD ellipses, the board's only card (full width; no time
 *                chart — by design)
 *
 * The tiles replaced Individual's "Statistics" table and the Relation model's stat
 * row. Rules (user decisions 2026-10-12 — do not undo them):
 *  - NO "Training rows" tile and NO "Trained" tile; rows / predictors / 2RMSE are
 *    not items of their own (2RMSE and the residual mean are captions).
 *  - Tiles never judge: plain values, no threshold colour, no "fair / weak fit".
 *  - A share that is not zero never reads as zero (`shareText`, `outsideText`).
 * The strip needs a preview, so the chart-less boards (not trained, queued,
 * training, failed, …) — drawn by `BuildModelWindow`, not here — have none.
 *
 * Only what the user needs to read the fit is here (user decision 2026-10-11):
 * there is NO "Train and scoring periods" table on this page for any kind, and
 * Clustering has NO side column (the "Clusters" summary card — rows / centre
 * per cluster — is gone). Do not add them back.
 *
 * A chart whose lines are labelled ON the chart has no legend row under it:
 * reference lines carry their name at the right
 * edge, the ring levels at the ring's edge. A legend row stays where DATA is told
 * apart by colour: Distribution (Rows / Normal curve), Fit (two point colours)
 * and Target vs predicted (Actual / Predicted — a fixed key, because a name
 * drawn at a line's end does not follow the line through a zoom). Design rule:
 * a name on the chart is the ONLY key only on a chart that cannot zoom or pan —
 * the Clusters chart zooms on both axes, so its rings have a fixed key too.
 *
 * Train and scoring periods: when the
 * preview carries `test_validation`, every time chart takes the train /
 * scoring scopes (`scopesOf` → `TimeSeriesSpec.scopes`): the line shows the rows
 * of both, but only the TRAIN periods are highlighted and named — a scoring
 * period has no band and no "S1" on a chart; an amber note shows
 * below the recommended train time. The per-period numbers ("Scoring results")
 * and the "health score could not be calculated — try again" notice are on the Health score page.
 *
 * The "Model settings" section and the footer are NOT here: they sit around this
 * body in `BuildModelWindow` (they share the draft/Apply state with the rest of
 * the window).
 */

export interface ModelFitPageProps extends WorkbenchPageProps {
    /** The data to draw. The container only renders this page once it exists. */
    data: HealthPreview;
    /** Relationship: the user picked another predictor for the Fit chart's X
     *  axis (written immediately by the container as `scatterXSensor`). */
    onXPredictorChange: (tag: string) => void;
    /** Relationship: open the Sub-models comparison modal. */
    onCompare: () => void;
    /** Why "Compare predictors" cannot run now (a training run is active: one
     *  Relation-model sidecar call at a time); absent = enabled. */
    compareDisabledReason?: string;
    /** Train running days known before Rust answers with `test_validation`
     *  (estimated from the Step-1 row count); `null`/absent = unknown. Drives
     *  only the amber "below the recommended train time" note — never a block. */
    trainDaysEstimate?: number | null;
}

/** The estimated share of training rows outside ±3SD. Two decimals, as this value
 *  has always been printed (a normal process gives about 0.27%); a share that is
 *  not zero never reads "0.00%". */
export function outsideText(pct: number): string {
    return pct > 0 && pct < 0.01 ? '< 0.01%' : `${pct.toFixed(2)}%`;
}

/** Memo comparison (see `samePageProps`): small data the window rebuilds per
 *  render is compared by value — the model (re-read from disk after every
 *  write), the scoring-period numbers; everything else by identity. */
export function sameModelFitProps(a: ModelFitPageProps, b: ModelFitPageProps): boolean {
    return samePageProps(a, b, ['model', 'testNumbers']);
}

function ModelFitPage(props: ModelFitPageProps) {
    const { data, model, stale, unit } = props;
    const stats = data.stats;
    const lookup = useSensorLookup();
    // Train / scoring scopes on every time chart (null = the preview carried no scoring periods).
    const scopes = scopesOf(data.test_validation, props.testNumbers);
    // With scopes a time chart shows exactly the rows of the periods named in its strip
    // (everything else is a gap); without them, every running row of the training scope.
    const rowsShown = scopes ? 'rows in the train and scoring periods' : 'running rows';
    const daysNotice = (
        <>
            <SlowScoringNotice show={props.slowScoring} />
            <TrainDaysNotice days={data.test_validation?.train.days ?? props.trainDaysEstimate ?? null} />
        </>
    );

    if (stats.kind === 'individual' && data.series.kind === 'individual') {
        const series = data.series;
        const outside = estimateRowsOutside3sd(data.histogram, stats);
        const outsidePct = outside === null || !stats.rows ? null : (outside / stats.rows) * 100;
        return (
            // One column: the tiles, then both charts at full width (`wb2-board--ind`
            // also makes the value chart taller).
            <div className="wb2-board wb2-board--ind" data-testid="model-fit-individual">
                <KpiStrip fit testId="fit-kpis">
                    <Kpi label="Mean" value={fmtNum(stats.mean)} unit={unit} sub="learned normal" testId="stat-mean" />
                    <Kpi
                        label="SD"
                        value={fmtNum(stats.sd)}
                        unit={unit}
                        sub={`±1SD ${fmtNum(stats.boundary_1sd[0])} – ${fmtNum(stats.boundary_1sd[1])}`}
                        testId="stat-sd"
                    />
                    <Kpi
                        label="Outside ±3SD"
                        value={outsidePct === null ? '—' : outsideText(outsidePct)}
                        sub={outside === null
                            ? 'no distribution'
                            : `≈ ${outside.toLocaleString('en-US')} ${outside === 1 ? 'row' : 'rows'} · ±3SD ${fmtNum(stats.boundary_3sd[0])} – ${fmtNum(stats.boundary_3sd[1])}`}
                        title="Estimated from the distribution bins"
                        testId="stat-outside3"
                    />
                </KpiStrip>
                {daysNotice}
                <ChartCard
                    id="ts"
                    title="Sensor value over time"
                    sub={`${unit ? `${unit} · ` : ''}${rowsShown} · green = within ±1SD (score 100) · amber dashes = ±3SD (score 80)`}
                    full
                    size="tall"
                    stale={stale}
                    option={buildValueOverTimeOption(series, stats, unit, scopes)}
                />
                <ChartCard
                    id="dist"
                    title="Distribution"
                    sub={`${unit ? `${unit} · ` : ''}rows per value`}
                    full
                    stale={stale}
                    option={data.histogram ? buildDistributionOption(data.histogram, individualVLines(stats), unit) : null}
                    empty="No distribution for this scope"
                    legend={<>
                        <LegendItem color={CHART.bar} label="Rows" square />
                        <LegendItem color={CHART.normalCurve} label="Normal curve" />
                    </>}
                />
            </div>
        );
    }

    if (stats.kind === 'relationship' && data.series.kind === 'relationship') {
        const series = data.series;
        const fit = data.fit_scatter;
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-relationship">
                <KpiStrip fit testId="rel-stats">
                    <Kpi label="R²" value={fmtNum(stats.r2)} sub="of the training rows" testId="stat-r2" />
                    <Kpi label="RMSE" value={fmtNum(stats.rmse)} unit={unit} sub={`±2RMSE ${fmtNum(stats.two_rmse)} = the score-100 band`} testId="stat-rmse" />
                    <Kpi label="Residual SD" value={fmtNum(stats.residual_sd)} unit={unit} sub={`mean ${fmtNum(stats.residual_mean)}`} testId="stat-res-sd" />
                </KpiStrip>
                {daysNotice}
                <ChartCard
                    id="fit"
                    title="Fit"
                    sub={<span className="wb2-sub-sl">predictor vs <SensorInline tag={model.targetSensor ?? ''} size="sm" muted /></span>}
                    stale={stale}
                    option={fit ? buildFitScatterOption(fit, unit || model.targetSensor) : null}
                    empty="No fit to draw"
                    extra={<>
                        {fit && fit.predictors.length > 0 && (
                            <span className="wb2-xsel" data-testid="fit-x-selector">
                                X:
                                {/* The compact single picker, scoped to this
                                    model's predictors. With one predictor it is disabled but
                                    still shows its value, and the tooltip gives the reason. */}
                                <span className="wb2-xpk" title={fit.predictors.length === 1 ? 'Only one predictor — nothing else to plot on X' : undefined}>
                                    <SensorPickerSingle
                                        compact
                                        alignRight
                                        sensors={fit.predictors}
                                        value={fit.x_sensor}
                                        onSelect={(t) => { if (t) props.onXPredictorChange(t); }}
                                        disabled={fit.predictors.length === 1}
                                        disabledReason={fit.predictors.length === 1 ? 'Only one predictor — nothing else to plot on X' : undefined}
                                        scope={<>Predictors of this model · {fit.predictors.length}</>}
                                        ariaLabel="X sensor"
                                    />
                                </span>
                            </span>
                        )}
                        <button
                            type="button"
                            className="rcx-btn rcx-btn--sm"
                            data-testid="compare-predictors"
                            disabled={!!props.compareDisabledReason}
                            title={props.compareDisabledReason}
                            onClick={props.onCompare}
                        >
                            <LayoutGrid size={12} aria-hidden="true" />Compare predictors
                        </button>
                    </>}
                    legend={<>
                        <LegendItem color={CHART.actual} label="Actual" square />
                        <LegendItem color={CHART.predicted} label="Relation model" square />
                    </>}
                />
                <ChartCard
                    id="tvp"
                    title="Target vs predicted"
                    sub={`${unit ? `${unit} · ` : ''}${rowsShown}`}
                    stale={stale}
                    option={buildTargetVsPredictedOption(series, unit, compactScopes(scopes))}
                    legend={<>
                        <LegendItem color={CHART.actual} label="Actual" />
                        <LegendItem color={CHART.predicted} label="Predicted" />
                    </>}
                />
                <ChartCard
                    id="res"
                    title="Residual over time"
                    sub={`actual − predicted${unit ? ` (${unit})` : ''}`}
                    full
                    stale={stale}
                    option={buildResidualOption(series, stats.two_rmse, unit, scopes)}
                />
            </div>
        );
    }

    if (stats.kind === 'clustering') {
        const scatter = data.cluster_scatter;
        const xTag = model.xSensor ?? '';
        const yTag = model.ySensor ?? '';
        // Rust sends the train block (`test_validation`) only with scoring periods:
        // without it this share is not known here and the tile reads "—".
        const insideRing = data.test_validation?.train.inside_3sd_ring_pct;
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-clustering">
                <KpiStrip fit testId="cl-stats">
                    <Kpi
                        label="Clusters"
                        value={stats.cluster_count}
                        sub={stats.criteria_sensor
                            ? <span className="wb2-sub-sl">split by <SensorInline tag={stats.criteria_sensor} size="sm" muted /></span>
                            : 'one cluster · no criteria sensor'}
                        testId="stat-clusters"
                    />
                    <Kpi
                        label="In a cluster"
                        value={stats.rows ? shareText((stats.assigned_rows / stats.rows) * 100) : '—'}
                        sub={`${stats.unassigned_rows.toLocaleString('en-US')} ${stats.unassigned_rows === 1 ? 'row' : 'rows'} outside every criteria range`}
                        testId="stat-assigned"
                    />
                    <Kpi
                        label="Inside 3× SD"
                        value={insideRing != null ? shareText(insideRing) : '—'}
                        sub="of the training rows · score ≥ 80"
                        testId="stat-inside3"
                    />
                </KpiStrip>
                {daysNotice}
                <ChartCard
                    id="cl"
                    title="Clusters"
                    sub={<span className="wb2-sub-sl"><SensorInline tag={xTag} size="sm" muted /> vs <SensorInline tag={yTag} size="sm" muted /></span>}
                    // The board's only card: it spans both columns (no side column).
                    full
                    size="xtall"
                    stale={stale}
                    // Axis titles: description + unit — the tags are in the subtitle above.
                    option={scatter ? buildClusterOption(scatter, stats.clusters, { x: sensorAxisTitle(lookup(xTag)), y: sensorAxisTitle(lookup(yTag)) }) : null}
                    empty="No clusters to draw"
                    // A fixed key for the rings: this chart zooms and pans on both axes, and
                    // the name drawn at a ring's edge leaves the view with that edge.
                    legend={scatter ? <span data-testid="ring-key" style={{ display: 'contents' }}>
                        <LegendItem color={CHART.ok} label="1× SD" />
                        <LegendItem color={CHART.warn} label="3× SD" dashed />
                    </span> : undefined}
                />
            </div>
        );
    }

    return null;
}

export default memo(ModelFitPage, sameModelFitProps);
