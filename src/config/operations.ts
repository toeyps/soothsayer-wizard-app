import type { OperationDefinition } from '../types/calculationEngine';

/**
 * Operation Registry -- Single Source of Truth
 *
 * All available sensor operations are defined here -- both the frontend UI
 * (button labels/symbols) and `useCalculationEngine`'s routing logic derive
 * from these definitions.
 *
 * Every id here is actually computable. Most single-sensor ops and the
 * "sum/mean/median/product/subtract/divide" multi-sensor ops route through
 * the Rust `calculate_new_sensor` command (see `operation_registry.rs`).
 * The newer named multi-sensor ops (`temp_spread`, `abs_diff`,
 * `efficiency_pct`) have no equivalent there -- `useCalculationEngine`
 * builds a formula string for them instead and routes through
 * `evaluate_formula`. Moving Average and Rate of Change were removed from
 * this registry entirely because they were never implemented anywhere --
 * selecting them previously built a config the backend silently rejected,
 * so the sensor was added with no calculation applied at all.
 */
export const OPERATIONS: {
  single: OperationDefinition[];
  multi: OperationDefinition[];
} = {
  single: [
    { id: 'add', label: 'Add', symbol: '+', requiresValue: true },
    { id: 'subtract', label: 'Subtract', symbol: '-', requiresValue: true },
    { id: 'multiply', label: 'Multiply', symbol: '×', requiresValue: true },
    { id: 'divide', label: 'Divide', symbol: '÷', requiresValue: true },
    { id: 'power', label: 'Raise to power', symbol: '^', requiresValue: true },
    { id: 'abs', label: 'Absolute value', symbol: 'abs', requiresValue: false },
    { id: 'sqrt', label: 'Square root', symbol: '√', requiresValue: false },
    { id: 'log10', label: 'Log (base 10)', symbol: 'log₁₀', requiresValue: false },
    { id: 'exp', label: 'Exponential', symbol: 'exp', requiresValue: false },
    { id: 'ceil', label: 'Round up', symbol: 'ceil', requiresValue: false },
    { id: 'floor', label: 'Round down', symbol: 'floor', requiresValue: false },
    { id: 'round', label: 'Round to decimals', symbol: 'round', requiresValue: true },
  ],
  multi: [
    { id: 'sum', label: 'Sum all', symbol: 'Σ', requiresValue: false },
    { id: 'mean', label: 'Average all', symbol: 'μ', requiresValue: false },
    { id: 'median', label: 'Median', symbol: 'M̃', requiresValue: false },
    { id: 'temp_spread', label: 'Spread (max − min)', symbol: 'Δ', requiresValue: false },
    { id: 'abs_diff', label: 'Absolute difference', symbol: '|Δ|', requiresValue: false },
    { id: 'efficiency_pct', label: 'Efficiency % (output ÷ input × 100)', symbol: '%', requiresValue: false, requiresBase: true },
  ],
} as const;

/** Find an operation by id */
export function findOperation(
  type: 'single' | 'multi',
  id: string,
): OperationDefinition | undefined {
  return (OPERATIONS[type] as readonly OperationDefinition[]).find(
    (op) => op.id === id,
  );
}
