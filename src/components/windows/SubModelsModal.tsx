import { useEffect } from 'react';
import { Activity, Loader2, X } from 'lucide-react';
import ResponsiveECharts from '../charts/ResponsiveECharts';
import type { SubModelFit, SubModelFitsState } from './useSubModelFits';

/*
 * "Sub-models" / "Compare predictors" modal: one Relation-model fit per
 * cumulative predictor subset, each with its own R^2 / RMSE / 2*RMSE / N and a
 * scatter that shares the first predictor as X so the cards compare
 * apples-to-apples.
 *
 * Extracted from the (since deleted) PredictiveModelBuild.tsx page in health
 * score phase 3b-1, 2026-10-04; the Build Model Workbench's Model fit page
 * ("Compare predictors") is its only caller. Class names are the old page's
 * (`pm-preview-modal-*` / `pm-submodel*`). Preview only — nothing is saved.
 */

/** ECharts scatter option for ONE sub-model fit — Raw (blue) vs Model (red)
 *  against `xSensor`. Compact margins/fonts for the card layout. */
export function buildSubModelOption(fit: SubModelFit, xSensor: string, targetSensor: string) {
    const { result, predictors } = fit;
    const xRaw = result.predictor_raw;
    const yRaw = result.target_raw;
    const yPred = result.predicted;
    if (!xRaw || !yRaw || !yPred) return null;
    if (xRaw.length === 0) return null;

    const xIdx = predictors.indexOf(xSensor);
    if (xIdx < 0) return null;

    // Same literal values LineChart.tsx uses (ECharts renders to canvas and
    // cannot read CSS custom properties) — kept in sync by eye.
    const txtPrimary = '#ededef';
    const txtSecondary = '#8c8c94';
    const gridLine = '#2a2a30';
    const tooltipBg = 'rgba(23, 23, 28, 0.92)';
    const tooltipBorder = 'rgba(255, 255, 255, 0.12)';

    const rawPoints: [number, number][] = [];
    const modelPoints: [number, number][] = [];
    const n = Math.min(xRaw.length, yRaw.length, yPred.length);
    for (let i = 0; i < n; i++) {
        const xv = xRaw[i]?.[xIdx];
        if (typeof xv !== 'number' || !Number.isFinite(xv)) continue;
        const yr = yRaw[i];
        if (typeof yr === 'number' && Number.isFinite(yr)) rawPoints.push([xv, yr]);
        const yp = yPred[i];
        if (typeof yp === 'number' && Number.isFinite(yp)) modelPoints.push([xv, yp]);
    }

    const totalPoints = rawPoints.length + modelPoints.length;
    const isLargeData = totalPoints > 2000;
    const isHugeData = totalPoints > 20000;
    const symbolSize = isHugeData ? 2 : isLargeData ? 3 : 5;
    const pointOpacity = isHugeData ? 0.18 : isLargeData ? 0.35 : 0.55;

    const seriesCommon = {
        type: 'scatter' as const,
        symbolSize,
        large: isLargeData,
        largeThreshold: 2000,
        progressive: 5000,
        progressiveThreshold: 10000,
        emphasis: { scale: !isHugeData, disabled: isHugeData },
        silent: isHugeData,
    };

    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
        animation: !isLargeData,
        tooltip: {
            trigger: 'item',
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            textStyle: { color: txtPrimary },
            formatter: (p: any) => {
                const v = p.value as [number, number];
                return `<div style="font-weight:bold;margin-bottom:4px;color:${p.color}">${p.seriesName}</div>`
                    + `<div>${xSensor}: ${typeof v?.[0] === 'number' ? v[0].toFixed(4) : '—'}</div>`
                    + `<div>${targetSensor}: ${typeof v?.[1] === 'number' ? v[1].toFixed(4) : '—'}</div>`;
            },
        },
        legend: {
            data: ['Raw', 'Model'],
            textStyle: { color: txtSecondary, fontSize: 11 },
            top: 4,
            right: 10,
            itemWidth: 10,
            itemHeight: 10,
        },
        grid: { left: 56, right: 22, top: 32, bottom: 50, containLabel: false },
        dataZoom: [
            { type: 'inside', xAxisIndex: 0, filterMode: 'filter' },
            { type: 'inside', yAxisIndex: 0, filterMode: 'filter' },
        ],
        xAxis: {
            type: 'value',
            name: xSensor,
            nameLocation: 'middle',
            nameGap: 26,
            nameTextStyle: { color: txtSecondary, fontSize: 11 },
            scale: true,
            axisLabel: { color: txtSecondary, fontSize: 10 },
            axisLine: { lineStyle: { color: gridLine } },
            splitLine: { show: false },
        },
        yAxis: {
            type: 'value',
            name: targetSensor,
            nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: { color: txtSecondary, fontSize: 11 },
            scale: true,
            axisLabel: { color: txtSecondary, fontSize: 10 },
            axisLine: { lineStyle: { color: gridLine } },
            splitLine: { show: true, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } },
        },
        series: [
            { ...seriesCommon, name: 'Raw', data: rawPoints, itemStyle: { color: '#3b82f6', opacity: pointOpacity } },
            { ...seriesCommon, name: 'Model', data: modelPoints, itemStyle: { color: '#f43f5e', opacity: pointOpacity } },
        ],
    };
}

export interface SubModelsModalProps {
    /** The state of `useSubModelFits` for this model. */
    fits: SubModelFitsState;
    targetSensor: string;
    /** Number of predictors the model has right now (0 = nothing to compare). */
    predictorCount: number;
    /** Human label of the model's stiffness ("Medium", ...). */
    stiffnessText: string;
    onClose: () => void;
}

export default function SubModelsModal({ fits, targetSensor, predictorCount, stiffnessText, onClose }: SubModelsModalProps) {
    const { subModels, loading, error, progress, stale, run } = fits;

    // Escape closes the modal (same convention as the chart-expand modals).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="pm-preview-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Sub-models" data-testid="sub-models-modal">
            <div className="pm-preview-modal-card pm-submodels-modal-card" onClick={e => e.stopPropagation()}>
                <div className="pm-preview-modal-header">
                    <div className="pm-chart-title-block">
                        <div className="pm-chart-title">Sub-models</div>
                        <div className="pm-chart-subtitle">
                            One Relation model fit per cumulative-feature subset · target: <code>{targetSensor || '—'}</code> · stiffness: <code>{stiffnessText}</code>
                        </div>
                    </div>
                    <button className="pm-chart-modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
                        <X size={18} />
                    </button>
                </div>
                <div className="pm-preview-modal-body pm-submodels-body">
                    {!targetSensor ? (
                        <div className="pm-preview-empty">No target sensor selected.</div>
                    ) : predictorCount === 0 ? (
                        <div className="pm-preview-empty">Add at least one predictor to compute sub-models.</div>
                    ) : loading ? (
                        <div className="pm-preview-empty">
                            <Loader2 size={14} className="animate-spin" />
                            Fitting Relation model {Math.min(progress.current + 1, progress.total)} of {progress.total}…
                        </div>
                    ) : error ? (
                        <div className="pm-preview-error">{error}</div>
                    ) : !subModels || subModels.length === 0 ? (
                        <div className="pm-preview-empty">
                            No sub-models computed yet.
                            <button className="pm-btn pm-btn-secondary pm-btn-sm" onClick={() => { void run(); }} style={{ marginLeft: 8 }}>
                                Run now
                            </button>
                        </div>
                    ) : (
                        <>
                            {stale && (
                                <div className="pm-submodels-stale-banner">
                                    <span>Predictor selection changed since last fit — these results may be stale.</span>
                                    <button className="pm-btn pm-btn-secondary pm-btn-sm" onClick={() => { void run(); }} disabled={loading}>
                                        Refresh
                                    </button>
                                </div>
                            )}
                            {subModels.map((fit, idx) => {
                                // The last entry of `r2_per_step` is the score for the full
                                // subset of THIS sub-fit (sidecar contract) — the card's headline R².
                                const r2 = fit.result.r2_per_step[fit.result.r2_per_step.length - 1];
                                const rmse2 = fit.result.rmse2_per_step[fit.result.rmse2_per_step.length - 1];
                                const xSensor = fit.predictors[0] ?? '';
                                const opt = buildSubModelOption(fit, xSensor, targetSensor);
                                return (
                                    <div key={idx} className="pm-submodel-card" data-testid="sub-model-card">
                                        <div className="pm-submodel-header">
                                            <div className="pm-submodel-title-block">
                                                <div className="pm-submodel-step">Step {idx + 1} of {subModels.length}</div>
                                                <div className="pm-submodel-predictors">
                                                    <code>{fit.predictors.join(' + ')}</code>
                                                    <span className="pm-submodel-arrow"> → </span>
                                                    <code>{targetSensor}</code>
                                                </div>
                                            </div>
                                            <div className="pm-submodel-stats">
                                                <div className="pm-submodel-stat">
                                                    <span className="pm-submodel-stat-label">R²</span>
                                                    <span className="pm-submodel-stat-value">{typeof r2 === 'number' ? r2.toFixed(4) : '—'}</span>
                                                </div>
                                                <div className="pm-submodel-stat">
                                                    <span className="pm-submodel-stat-label">RMSE</span>
                                                    <span className="pm-submodel-stat-value">{typeof rmse2 === 'number' ? (rmse2 / 2).toFixed(4) : '—'}</span>
                                                </div>
                                                <div className="pm-submodel-stat">
                                                    <span className="pm-submodel-stat-label">2·RMSE</span>
                                                    <span className="pm-submodel-stat-value">{typeof rmse2 === 'number' ? rmse2.toFixed(4) : '—'}</span>
                                                </div>
                                                <div className="pm-submodel-stat">
                                                    <span className="pm-submodel-stat-label">N</span>
                                                    <span className="pm-submodel-stat-value">{typeof fit.result.n_rows === 'number' ? fit.result.n_rows.toLocaleString() : '—'}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="pm-submodel-chart">
                                            {opt ? (
                                                <ResponsiveECharts option={opt} style={{ height: '280px', minHeight: '280px' }} />
                                            ) : (
                                                <div className="plot-placeholder pm-chart-placeholder">
                                                    <Activity size={32} style={{ opacity: 0.2 }} />
                                                    <p>No data to render</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
