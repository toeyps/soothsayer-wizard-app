/** Definition of a single operation in the registry */
export interface OperationDefinition {
  id: string;
  label: string;
  symbol: string;
  /** Whether this operation needs a numeric value input (e.g., add needs a value) */
  requiresValue: boolean;
  /** Whether this operation needs a base sensor (e.g., subtract needs a starting value) */
  requiresBase?: boolean;
}

/** Result of formula validation (returned by validate_formula command) */
export interface FormulaValidationResult {
  valid: boolean;
  error: string | null;
  /** Sensor names referenced in the formula (extracted from $SensorName tokens) */
  referenced_sensors: string[];
}
