import { memo } from 'react';
import { samePageProps } from './pageMemo';
import { LayoutGrid } from 'lucide-react';
import { SensorPickerSingle } from '../../sensor/SensorPicker';
import { SensorInline } from '../../sensor/SensorLabel';
import { PairSub } from './PairSub';
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
    clusterChartNames,
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

/* Model fit body per kind from the bounded `HealthPreview`, never row arrays; tiles never judge; a non-zero share never reads as zero. Model settings and footer live in `BuildModelWindow`. */

export interface ModelFitPageProps extends WorkbenchPageProps {
    /** The data to draw. The container only renders this page once it exists. */
    data: HealthPreview;
    /** Relationship: the user picked another predictor for the Fit chart's X axis. */
    onXPredictorChange: (tag: string) => void;
    /** Relationship: open the Sub-models comparison modal. */
    onCompare: () => void;
    /** Why Compare predictors can't run (one Relation-model sidecar call at a time); absent = enabled. */
    compareDisabledReason?: string;
    /** Train running days known before Rust returns `test_validation` (from the Step-1 row count); only drives the amber note, never blocks. */
    trainDaysEstimate?: number | null;
}

/** Share of training rows outside ±3SD, two decimals; a non-zero share never reads "0.00%". */
export function outsideText(pct: number): string {
    return pct > 0 && pct < 0.01 ? '< 0.01%' : `${pct.toFixed(2)}%`;
}

/** Caption of Clustering's "In a cluster" tile: what the share is of, in words —
 *  never the number of rows. */
export function inClusterSub(unassignedRows: number, hasCriteriaSensor: boolean): string {
    if (unassignedRows > 0) return 'the rest is outside every criteria range';
    return hasCriteriaSensor ? 'every training row is in a criteria range' : 'every training row is in the cluster';
}

/** Memo compare: the model and scoring-period numbers by value, everything else by identity. */
export function sameModelFitProps(a: ModelFitPageProps, b: ModelFitPageProps): boolean {
    return samePageProps(a, b, ['model', 'testNumbers']);
}

function ModelFitPage(props: ModelFitPageProps) {
    const { data, model, stale, unit } = props;
    const stats = data.stats;
    const lookup = useSensorLookup();
    // Train / scoring scopes on every time chart (null = the preview carried no scoring periods).
    const scopes = scopesOf(data.test_validation, props.testNumbers);
    // With scopes a time chart shows only the rows of the strip's periods; without, every running row of the training scope.
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
                            : `±3SD ${fmtNum(stats.boundary_3sd[0])} – ${fmtNum(stats.boundary_3sd[1])}`}
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
                    option={fit ? buildFitScatterOption(
                        fit,
                        // The Y title: the unit, or the target's name when it has none (never the bare tag).
                        unit || sensorAxisTitle(lookup(model.targetSensor ?? '')),
                        lookup(fit.x_sensor),
                        unit ? undefined : lookup(model.targetSensor ?? ''),
                    ) : null}
                    empty="No fit to draw"
                    extra={<>
                        {fit && fit.predictors.length > 0 && (
                            <span className="wb2-xsel" data-testid="fit-x-selector">
                                X:
                                {/* Compact single picker scoped to this model's predictors; disabled with a reason when there is only one. */}
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
                />
                <ChartCard
                    id="tvp"
                    title="Target vs predicted"
                    sub={`${unit ? `${unit} · ` : ''}${rowsShown}`}
                    stale={stale}
                    option={buildTargetVsPredictedOption(series, unit, compactScopes(scopes))}
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
        // In the stats, so it is known with or without scoring periods ("—" only when no
        // training row has a usable cluster).
        const insideRing = stats.inside_3sd_ring_pct;
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-clustering">
                <KpiStrip fit testId="cl-stats">
                    <Kpi
                        label="Clusters"
                        value={stats.cluster_count}
                        sub={stats.criteria_sensor
                            ? <span className="wb2-sub-sl"><span className="wb2-sub-lead">split by </span><SensorInline tag={stats.criteria_sensor} size="sm" muted /></span>
                            : 'one cluster · no criteria sensor'}
                        testId="stat-clusters"
                    />
                    <Kpi
                        label="In a cluster"
                        value={stats.rows ? shareText((stats.assigned_rows / stats.rows) * 100) : '—'}
                        sub={inClusterSub(stats.unassigned_rows, !!stats.criteria_sensor)}
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
                    sub={<PairSub x={xTag} y={yTag} />}
                    // The board's only card: it spans both columns (no side column).
                    full
                    size="xtall"
                    stale={stale}
                    // Axis titles: description + unit — the tags are in the subtitle above.
                    option={scatter ? buildClusterOption(scatter, stats.clusters, clusterChartNames(lookup(xTag), lookup(yTag))) : null}
                    empty="No clusters to draw"
                    // Fixed ring key: this chart zooms on both axes, so a name drawn at a ring's edge leaves the view.
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
