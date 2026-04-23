export interface CsvRecord {
    timestamp: string | null;
    values: (number | null)[];
}

export interface ProcessedData {
    headers: string[];
    rows: CsvRecord[];
}

export interface CsvMetadata {
    headers: string[];
    total_rows: number;
}

export interface SensorMetadata {
    tag: string;
    description: string;
    unit: string;
    component: string;
}

export type SingleOperationType = 'add' | 'subtract' | 'multiply' | 'divide' | 'power';
export type MultiOperationType = 'sum' | 'mean' | 'median' | 'product' | 'subtract' | 'divide';

export interface SensorOperationConfig {
    mode: 'single' | 'multi';
    singleOp?: {
        type: SingleOperationType;
        value: number;
    };
    multiOp?: {
        type: MultiOperationType;
        baseSensor?: string;
    };
    customName?: string;
}

export interface WorkspaceMetadata {
    id: string;
    name: string;
    lastModified: number;
    filePath: string;
}

export interface WorkspaceSensorFilter {
    id: string;
    sensor: string;
    operation: 'less_than' | 'greater_than' | 'between' | 'equals';
    value1: string;
    value2: string;
}

export interface WorkspaceFilterState {
    timestampStart: string;
    timestampEnd: string;
    sensorFilters: WorkspaceSensorFilter[];
}

// Snapshot of Dashboard's applied filtering/processing state captured on Save & Continue.
// Used by Step 2/3 so filtering context carries forward.
export interface DashboardSnapshot {
    selectedSensors: string[];
    visibleSensors: string[];
    operationConfig: SensorOperationConfig | null;
    filters: WorkspaceFilterState;
    samplingMethod: 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';
}

export interface FailureGroup {
    no: number;
    name: string;
    isCollapsed: boolean;
}

export interface FailureSensorRow {
    id: string;
    groupNo: number;
    conceptSensor: string;
    mappedSensorTag: string;
    mappedSensorName: string;
    modelType: string;
    modelNotes: string;
    additionalNotes: string;
    status: boolean;
}

export interface FailureGroupStateSlice {
    groups: FailureGroup[];
    rows: FailureSensorRow[];
}

export interface PredictiveModelStateSlice {
    targetSensor: string;
    predictorSensors: string[];
    individualChecked: boolean;
    rcMode: 'relationship' | 'clustering' | null;
    scatterXSensor: string;
    relModelName: string;
    relStiffness: number;
    clusterModelName: string;
    numClusters: number;
    criteriaSensor: string;
    clusterRangeMin: number;
    clusterRangeMax: number;
    filterTimeStart: string;
    filterTimeEnd: string;
    filterSensorValue: string;
}

export type WorkspaceRoute = 'import' | 'dashboard' | 'failure-group' | 'predictive-model';

export interface WorkspaceState {
    id: string;
    name: string;
    lastRoute: WorkspaceRoute;
    dataFilePaths: string[];
    metadataFilePath: string | null;
    selectedSensors: string[];
    visibleSensors: string[];
    operationConfig: SensorOperationConfig | null;
    filters?: WorkspaceFilterState;
    chartType?: 'line' | 'scatter' | 'pair';
    samplingMethod?: 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';
    collapsedPanels?: string[];
    mappingFilePath?: string | null;
    mappingKeyColumn?: string | null;
    dashboardSnapshot?: DashboardSnapshot;
    failureGroupState?: FailureGroupStateSlice;
    predictiveModelState?: PredictiveModelStateSlice;
}
