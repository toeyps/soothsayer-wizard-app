/** Parameter definition for operations that need extra inputs */
export interface OperationParam {
  name: string;
  type: 'number' | 'string';
  default: number | string;
}

/** Definition of a single operation in the registry */
export interface OperationDefinition {
  id: string;
  label: string;
  symbol: string;
  category: 'arithmetic' | 'transform' | 'aggregation' | 'time_series';
  /** Whether this operation needs a numeric value input (e.g., add needs a value) */
  requiresValue: boolean;
  /** Whether this operation needs a base sensor (e.g., subtract needs a minuend) */
  requiresBase?: boolean;
  /** Additional parameters beyond the basic value */
  params?: OperationParam[];
}

/** Unified calculation config sent to the backend */
export interface SensorCalculationConfig {
  mode: 'simple' | 'formula';
  /** Simple mode config -- used when mode === 'simple' */
  simple?: {
    operationId: string;
    sensors: string[];
    value?: number;
    baseSensor?: string;
    params?: Record<string, number>;
  };
  /** Formula mode config -- used when mode === 'formula' */
  formula?: {
    expression: string;
  };
  customName?: string;
}

/** Result of formula validation (returned by validate_formula command) */
export interface FormulaValidationResult {
  valid: boolean;
  error: string | null;
  /** Sensor names referenced in the formula (extracted from $SensorName tokens) */
  referenced_sensors: string[];
}
