/**
 * Data shape consumed by `<PMReportTemplate />`. Decoupled from the PM
 * page's React state so the template stays pure (data in → PDF out) and
 * the page can be refactored without breaking the report.
 *
 * Conventions:
 *   • All sensor references carry their human description + unit alongside
 *     the tag, because the report is meant for someone OTHER than the
 *     person who built the model — they may not recognize a bare tag.
 *   • Numeric values are kept as numbers (not formatted strings) so the
 *     template can apply its own formatting rules consistently.
 *   • Optional sections (preview chart, model config) are nullable; the
 *     template renders a "—" placeholder when absent so the doc stays
 *     readable even for partly-configured models.
 */

import type { WorkspaceSensorFilter } from '../../types';

/** Mirror of the SensorStats interface declared locally in PM page. */
export interface ReportSensorStats {
    mean: number;
    sd: number;
    min: number;
    max: number;
    count: number;
}

/** Sensor + its lookup data, repeated wherever a sensor reference appears. */
export interface ReportSensorRef {
    tag: string;
    description: string;
    unit: string;
    component: string;
}

/** Per-cluster numeric range (matches PredictiveClusterRange). */
export interface ReportClusterRange {
    min: number | null;
    max: number | null;
}

/**
 * Captured chart image — base64 PNG data URL from ECharts' `getDataURL`.
 * The template embeds it via `<Image src={dataUrl} />`.
 */
export interface ReportChartImage {
    label: string;            // e.g. "Relationship preview" or "Cluster 2 scatter"
    dataUrl: string;
    /** Aspect ratio hint so the template reserves the right height; can be
     *  omitted in which case react-pdf uses the image's intrinsic ratio. */
    aspectRatio?: number;
}

export interface PMReportData {
    /** Header / footer / file-name metadata. */
    meta: {
        workspaceName: string;
        generatedAt: Date;
    };

    /** The sensor being modelled. */
    target: {
        ref: ReportSensorRef;
        stats: ReportSensorStats | null;
    };

    /** Sensors the model is allowed to use as inputs. */
    predictors: Array<{
        ref: ReportSensorRef;
        stats: ReportSensorStats | null;
    }>;

    /** If true, the user requested an Individual-mode model in addition to
     *  whichever rcMode they picked. Surfaced in the Model Configuration
     *  section so the reader sees the full Save set. */
    individualChecked: boolean;

    /** Which model mode was chosen: relationship, clustering, or neither
     *  (user hadn't picked one yet at export time). */
    mode: 'relationship' | 'clustering' | null;

    filters: {
        timeStart: string;                       // ISO string or '' if unbounded
        timeEnd: string;
        /** Comes from the upstream Dashboard's filter slice. */
        dashboardFilters: WorkspaceSensorFilter[];
        /** Set on the PM page itself. */
        pmFilters: WorkspaceSensorFilter[];
    };

    /** Populated when mode === 'relationship'. */
    relationshipConfig: {
        modelName: string;
        stiffness: number;
        scatterXSensor: string;
        /** Preview metrics from the latest Apply, if any. */
        r2: number | null;
        rmse: number | null;
    } | null;

    /** Populated when mode === 'clustering'. */
    clusteringConfig: {
        modelName: string;
        criteriaSensor: string;
        numClusters: number;
        ranges: ReportClusterRange[];
    } | null;

    /** Optional chart screenshots from ECharts' own `getDataURL`. The
     *  template renders one per page (or stacked) under "Preview Results". */
    chartImages: ReportChartImage[];
}
