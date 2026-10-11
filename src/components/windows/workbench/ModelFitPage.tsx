import { memo } from 'react';
import { samePageProps } from './pageMemo';
import { LayoutGrid } from 'lucide-react';
import { SensorPickerSingle } from '../../sensor/SensorPicker';
import { SensorInline } from '../../sensor/SensorLabel';
import { useSensorLookup } from '../../sensor/sensorInfo';
import type { ClusterStat, HealthPreview } from '../../../types/health';
import ChartCard, { LegendItem } from './ChartCard';
import { CHART, CLUSTER_COLORS, fmtClusterBound, fmtNum } from './chartTheme';
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
import { SlowScoringNotice, TrainDaysNotice, TrainTestCard } from './ValidationCards';
import type { WorkbenchPageProps } from './workbenchTypes';

/*
 * Page 1 of the Workbench — "Model fit" body: the charts
 * and statistics of the TRAINED model, per kind. Everything comes from the
 * bounded `HealthPreview` Rust returns (`useHealthPreview`), never from row
 * arrays.
 *
 *   Individual   Sensor value over time (±1SD/±3SD) · Distribution · Statistics
 *   Relationship stats strip · Fit (+ X selector, Compare predictors) ·
 *                Target vs predicted · Residual over time (±2RMSE)
 *                (no residual distribution, no side histogram — by design)
 *   Clustering   scatter + 1×/3× SD ellipses · cluster summary card
 *                (no time chart — by design)
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
 * preview carries `test_validation`, every time chart draws the train /
 * scoring scopes (`scopesOf` → `TimeSeriesSpec.scopes`) and a "Train and
 * scoring periods" card is added (side column for Individual / Clustering, a
 * capped full row for Relationship), plus an amber note below the recommended
 * train time.
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

const Stat = ({ label, value, testId }: { label: string; value: string; testId?: string }) => (
    <span data-testid={testId}>{label}<b>{value}</b></span>
);

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
    const custom = model.runningConditionMode === 'custom';
    const daysNotice = (
        <>
            <SlowScoringNotice show={props.slowScoring} />
            <TrainDaysNotice days={data.test_validation?.train.days ?? props.trainDaysEstimate ?? null} />
        </>
    );
    // "Try again" on the test_scoring_failed notice also asks Rust to retry the
    // remembered failed prediction (a plain retry would get the same warning back).
    const vt = { testNumbers: props.testNumbers, onRetry: props.preview.retryTestScoring ?? props.preview.retry };

    if (stats.kind === 'individual' && data.series.kind === 'individual') {
        const series = data.series;
        const outside = estimateRowsOutside3sd(data.histogram, stats);
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-individual">
                {daysNotice}
                <ChartCard
                    id="ts"
                    title="Sensor value over time"
                    sub={`${unit ? `${unit} · ` : ''}${rowsShown}`}
                    full
                    size="tall"
                    stale={stale}
                    option={buildValueOverTimeOption(series, stats, unit, scopes)}
                />
                <ChartCard
                    id="dist"
                    title="Distribution"
                    sub={`${unit ? `${unit} · ` : ''}rows per value`}
                    stale={stale}
                    option={data.histogram ? buildDistributionOption(data.histogram, individualVLines(stats), unit) : null}
                    empty="No distribution for this scope"
                    legend={<>
                        <LegendItem color={CHART.bar} label="Rows" square />
                        <LegendItem color={CHART.normalCurve} label="Normal curve" />
                    </>}
                />
                <div className="vt-stack" data-testid="fit-side">
                    <section className="wb2-statc" data-testid="stats-card">
                        <div className="wb2-card-h"><b>Statistics</b><span className="wb2-card-s">from the training rows</span></div>
                        <table>
                            <tbody>
                                <tr><td>Rows</td><td className="n" data-testid="stat-rows">{stats.rows.toLocaleString()}</td></tr>
                                <tr><td>Mean</td><td className="n">{fmtNum(stats.mean)}{unit ? ` ${unit}` : ''}</td></tr>
                                <tr><td>SD</td><td className="n">{fmtNum(stats.sd)}{unit ? ` ${unit}` : ''}</td></tr>
                                <tr><td>±1SD</td><td className="n">{fmtNum(stats.boundary_1sd[0])} – {fmtNum(stats.boundary_1sd[1])}</td></tr>
                                <tr><td>±3SD</td><td className="n">{fmtNum(stats.boundary_3sd[0])} – {fmtNum(stats.boundary_3sd[1])}</td></tr>
                                <tr>
                                    <td title="Estimated from the distribution bins">Rows outside ±3SD</td>
                                    <td className="n" data-testid="stat-outside3">
                                        {outside === null ? '—' : `≈ ${outside.toLocaleString()} (${stats.rows ? ((outside / stats.rows) * 100).toFixed(2) : '0.00'}%)`}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </section>
                    <TrainTestCard data={data} unit={unit} side custom={custom} {...vt} />
                </div>
            </div>
        );
    }

    if (stats.kind === 'relationship' && data.series.kind === 'relationship') {
        const series = data.series;
        const fit = data.fit_scatter;
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-relationship">
                {daysNotice}
                <div className="wb2-stats wb2-full" data-testid="rel-stats">
                    <Stat label="R²" value={fmtNum(stats.r2)} testId="stat-r2" />
                    <Stat label="RMSE" value={`${fmtNum(stats.rmse)}${unit ? ` ${unit}` : ''}`} testId="stat-rmse" />
                    <Stat label="2RMSE" value={fmtNum(stats.two_rmse)} testId="stat-2rmse" />
                    <Stat label="Residual mean" value={fmtNum(stats.residual_mean)} testId="stat-res-mean" />
                    <Stat label="Residual SD" value={fmtNum(stats.residual_sd)} testId="stat-res-sd" />
                    <Stat label="Rows" value={stats.rows.toLocaleString('en-US')} testId="stat-rows" />
                    <Stat label="Predictors" value={String(stats.predictors.length)} testId="stat-predictors" />
                </div>
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
                <TrainTestCard data={data} unit={unit} custom={custom} {...vt} />
            </div>
        );
    }

    if (stats.kind === 'clustering') {
        const scatter = data.cluster_scatter;
        const xTag = model.xSensor ?? '';
        const yTag = model.ySensor ?? '';
        return (
            <div className="wb2-board wb2-hs" data-testid="model-fit-clustering">
                {daysNotice}
                <ChartCard
                    id="cl"
                    title="Clusters"
                    sub={<span className="wb2-sub-sl"><SensorInline tag={xTag} size="sm" muted /> vs <SensorInline tag={yTag} size="sm" muted /></span>}
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
                <div className="vt-stack" data-testid="fit-side">
                    <section className="wb2-statc wb2-statc--top" data-testid="cluster-summary">
                        <div className="wb2-card-h">
                            <b>Clusters</b>
                            {stats.criteria_sensor && <span className="wb2-card-s wb2-sub-sl">split by <SensorInline tag={stats.criteria_sensor} size="sm" muted /></span>}
                        </div>
                        <table>
                            <tbody>
                                {stats.clusters.map(c => (
                                    <ClusterRows key={c.cluster_id} c={c} />
                                ))}
                                {stats.unassigned_rows > 0 && (
                                    <tr><td>In no range</td><td className="n">{stats.unassigned_rows.toLocaleString()} rows</td></tr>
                                )}
                            </tbody>
                        </table>
                    </section>
                    <TrainTestCard data={data} unit={unit} side custom={custom} {...vt} />
                </div>
            </div>
        );
    }

    return null;
}

function ClusterRows({ c }: { c: ClusterStat }) {
    const color = CLUSTER_COLORS[(c.cluster_id - 1 + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];
    // The range is what the user typed in Model settings: printed as typed, never padded
    // ("33.6", not "33.60"); only an auto-divided boundary's float noise is shortened.
    const range = c.range && (c.range.min !== null || c.range.max !== null)
        ? ` · ${c.range.min !== null ? fmtClusterBound(c.range.min) : '…'} – ${c.range.max !== null ? fmtClusterBound(c.range.max) : '…'}`
        : '';
    return (
        <>
            <tr data-testid={`cluster-row-${c.cluster_id}`}>
                <td><i className="wb2-dot" style={{ background: color }} />Cluster {c.cluster_id}{range}</td>
                <td className="n">{c.n_rows.toLocaleString()} rows</td>
            </tr>
            <tr>
                <td className="wb2-sub">centre</td>
                <td className="n">x {fmtNum(c.x_center)} · y {fmtNum(c.y_center)}</td>
            </tr>
        </>
    );
}

export default memo(ModelFitPage, sameModelFitProps);
