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

export interface WorkspaceState {
    id: string;
    name: string;
    lastRoute: 'import' | 'dashboard';
    dataFilePaths: string[];
    metadataFilePath: string | null;
    selectedSensors: string[];
    visibleSensors: string[];
    operationConfig: SensorOperationConfig | null;
}
