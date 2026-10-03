import { LayoutGrid } from 'lucide-react';
import { SensorAutocomplete } from '../PredictiveModelBuild';
import type { ClusterStat, HealthPreview } from '../../../types/health';
import ChartCard, { LegendItem } from './ChartCard';
import { CHART, CLUSTER_COLORS, fmtNum } from './chartTheme';
import {
    buildClusterOption,
    buildDistributionOption,
    buildFitScatterOption,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildValueOverTimeOption,
    estimateRowsOutside3sd,
    individualVLines,
} from './healthCharts';
import type { WorkbenchPageProps } from './workbenchTypes';

/*
 * Page 1 of the Workbench — "Model fit" body (mockup `modelPage`): the charts
 * and statistics of the TRAINED model, per kind. Everything comes from the
 * bounded `HealthPreview` Rust returns (`useHealthPreview`), never from row
 * arrays.
 *
 *   Individual   Sensor value over time (±1SD/±3SD) · Distribution · Statistics
 *   Relationship stats strip · Fit (+ X selector, Compare predictors) ·
 *                Target vs predicted · Residual over time (±2RMSE)
 *                (no residual distribution, no side histogram — by design)
 *   Clustering   scatter + 1×/3× SD ellipses · cluster summary card
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
}

const Stat = ({ label, value, testId }: { label: string; value: string; testId?: string }) => (
    <span data-testid={testId}>{label}<b>{value}</b></span>
);

export default function ModelFitPage(props: ModelFitPageProps) {
    const { data, model, stale, unit, sensorLabel, getDesc } = props;
    const stats = data.stats;

    if (stats.kind === 'individual' && data.series.kind === 'individual') {
        const series = data.series;
        const outside = estimateRowsOutside3sd(data.histogram, stats);
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-individual">
                <ChartCard
                    id="ts"
                    title="Sensor value over time"
                    sub={`${unit ? `${unit} · ` : ''}running rows`}
                    full
                    size="tall"
                    stale={stale}
                    option={buildValueOverTimeOption(series, stats, unit)}
                    legend={<>
                        <LegendItem color={CHART.series} label="Value" />
                        <LegendItem color={CHART.ok} label="±1SD" />
                        <LegendItem color={CHART.warn} label="±3SD" />
                    </>}
                />
                <ChartCard
                    id="dist"
                    title="Distribution"
                    sub={`${unit ? `${unit} · ` : ''}bars = rows, line = normal curve from mean and SD`}
                    stale={stale}
                    option={data.histogram ? buildDistributionOption(data.histogram, individualVLines(stats), unit) : null}
                    empty="No distribution for this scope"
                    legend={<>
                        <LegendItem color={CHART.bar} label="Rows" square />
                        <LegendItem color={CHART.normalCurve} label="Normal curve" />
                        <LegendItem color={CHART.ok} label="±1SD" />
                        <LegendItem color={CHART.warn} label="±3SD" />
                    </>}
                />
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
            </div>
        );
    }

    if (stats.kind === 'relationship' && data.series.kind === 'relationship') {
        const series = data.series;
        const fit = data.fit_scatter;
        return (
            <div className="wb2-board wb2-g2" data-testid="model-fit-relationship">
                <div className="wb2-stats wb2-full" data-testid="rel-stats">
                    <Stat label="R²" value={fmtNum(stats.r2)} testId="stat-r2" />
                    <Stat label="RMSE" value={`${fmtNum(stats.rmse)}${unit ? ` ${unit}` : ''}`} testId="stat-rmse" />
                    <Stat label="2RMSE" value={fmtNum(stats.two_rmse)} testId="stat-2rmse" />
                    <Stat label="Residual mean" value={fmtNum(stats.residual_mean)} testId="stat-res-mean" />
                    <Stat label="Residual SD" value={fmtNum(stats.residual_sd)} testId="stat-res-sd" />
                    <Stat label="Rows" value={stats.rows.toLocaleString()} testId="stat-rows" />
                    <Stat label="Predictors" value={String(stats.predictors.length)} testId="stat-predictors" />
                </div>
                <ChartCard
                    id="fit"
                    title="Fit"
                    sub={`predictor vs ${sensorLabel(model.targetSensor)}`}
                    stale={stale}
                    option={fit ? buildFitScatterOption(fit, unit || model.targetSensor) : null}
                    empty="No fit to draw"
                    extra={<>
                        {fit && fit.predictors.length > 0 && (
                            <span className="wb2-xsel" data-testid="fit-x-selector">
                                X:
                                <SensorAutocomplete
                                    sensors={fit.predictors}
                                    getDesc={getDesc}
                                    value={fit.x_sensor}
                                    onSelect={props.onXPredictorChange}
                                    placeholder="Select X-axis sensor..."
                                    style={{ minWidth: '170px' }}
                                />
                            </span>
                        )}
                        <button type="button" className="rcx-btn rcx-btn--sm" data-testid="compare-predictors" onClick={props.onCompare}>
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
                    sub={`${unit ? `${unit} ` : ''}over time`}
                    stale={stale}
                    option={buildTargetVsPredictedOption(series, unit)}
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
                    option={buildResidualOption(series, stats.two_rmse, unit)}
                    legend={<>
                        <LegendItem color={CHART.series} label="Residual" />
                        <LegendItem color={CHART.ok} label="±2RMSE" />
                    </>}
                />
            </div>
        );
    }

    if (stats.kind === 'clustering') {
        const scatter = data.cluster_scatter;
        const xTag = model.xSensor ?? '';
        const yTag = model.ySensor ?? '';
        return (
            <div className="wb2-board wb2-hs" data-testid="model-fit-clustering">
                <ChartCard
                    id="cl"
                    title="Clusters"
                    sub={`${sensorLabel(xTag)} vs ${sensorLabel(yTag)}`}
                    size="xtall"
                    stale={stale}
                    option={scatter ? buildClusterOption(scatter, stats.clusters, { x: xTag, y: yTag }) : null}
                    empty="No clusters to draw"
                    legend={<>
                        <LegendItem color={CHART.ok} label="1× SD" />
                        <LegendItem color={CHART.warn} label="3× SD" dashed />
                    </>}
                />
                <section className="wb2-statc wb2-statc--top" data-testid="cluster-summary">
                    <div className="wb2-card-h">
                        <b>Clusters</b>
                        {stats.criteria_sensor && <span className="wb2-card-s">split by {sensorLabel(stats.criteria_sensor)}</span>}
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
            </div>
        );
    }

    return null;
}

function ClusterRows({ c }: { c: ClusterStat }) {
    const color = CLUSTER_COLORS[(c.cluster_id - 1 + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];
    const range = c.range && (c.range.min !== null || c.range.max !== null)
        ? ` · ${c.range.min !== null ? fmtNum(c.range.min) : '…'} – ${c.range.max !== null ? fmtNum(c.range.max) : '…'}`
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
