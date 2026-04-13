# Interface Contract -- Hybrid Calculation Engine (Feature 2)

## Feature: Flexible Sensor Calculation -- Simple + Advanced Mode

## New Tauri Commands

| Command | Args | Returns | Owner | Status |
|---------|------|---------|-------|--------|
| `calculate_new_sensor` (refactored) | `{ sensors: string[], config: SensorCalculationConfig }` | `string` | rust-agent | pending |
| `evaluate_formula` (new) | `{ formula: string, custom_name?: string }` | `string` | rust-agent | pending |
| `validate_formula` (new) | `{ formula: string }` | `FormulaValidationResult` | rust-agent | pending |

## New TypeScript Types

```typescript
// In src/types/calculationEngine.ts

/** Definition of a single operation in the registry */
export interface OperationParam {
  name: string;
  type: 'number' | 'string';
  default: number | string;
}

export interface OperationDefinition {
  id: string;
  label: string;
  symbol: string;
  category: 'arithmetic' | 'transform' | 'aggregation' | 'time_series';
  /** Whether this operation needs a numeric value input (e.g., add needs a value to add) */
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
  /** List of sensor names referenced in the formula (extracted from $SensorName tokens) */
  referenced_sensors: string[];
}
```

## Operation Registry (Frontend)

```typescript
// In src/config/operations.ts

import type { OperationDefinition } from '../types/calculationEngine';

export const OPERATIONS: {
  single: readonly OperationDefinition[];
  multi: readonly OperationDefinition[];
} = {
  single: [
    // Arithmetic (require a value)
    { id: 'add', label: 'Add (+)', symbol: '+', category: 'arithmetic', requiresValue: true },
    { id: 'subtract', label: 'Subtract (-)', symbol: '-', category: 'arithmetic', requiresValue: true },
    { id: 'multiply', label: 'Multiply (*)', symbol: '*', category: 'arithmetic', requiresValue: true },
    { id: 'divide', label: 'Divide (/)', symbol: '/', category: 'arithmetic', requiresValue: true },
    { id: 'power', label: 'Power (^)', symbol: '^', category: 'arithmetic', requiresValue: true },
    // Transform (no value needed)
    { id: 'abs', label: 'Absolute', symbol: 'abs', category: 'transform', requiresValue: false },
    { id: 'log10', label: 'Log base 10', symbol: 'log10', category: 'transform', requiresValue: false },
    { id: 'sqrt', label: 'Square Root', symbol: 'sqrt', category: 'transform', requiresValue: false },
    { id: 'round', label: 'Round', symbol: 'round', category: 'transform', requiresValue: false, params: [{ name: 'decimals', type: 'number', default: 2 }] },
  ],
  multi: [
    // Aggregation (no base needed)
    { id: 'sum', label: 'Sum', symbol: 'sum', category: 'aggregation', requiresValue: false, requiresBase: false },
    { id: 'mean', label: 'Average', symbol: 'avg', category: 'aggregation', requiresValue: false, requiresBase: false },
    { id: 'median', label: 'Median', symbol: 'median', category: 'aggregation', requiresValue: false, requiresBase: false },
    { id: 'product', label: 'Product', symbol: 'product', category: 'aggregation', requiresValue: false, requiresBase: false },
    // Arithmetic with base
    { id: 'subtract', label: 'Subtract (Difference)', symbol: '-', category: 'arithmetic', requiresValue: false, requiresBase: true },
    { id: 'divide', label: 'Divide (Ratio)', symbol: '/', category: 'arithmetic', requiresValue: false, requiresBase: true },
    // Time-series
    { id: 'moving_avg', label: 'Moving Average', symbol: 'ma', category: 'time_series', requiresValue: false, requiresBase: false, params: [{ name: 'window_size', type: 'number', default: 10 }] },
    { id: 'rate_of_change', label: 'Rate of Change', symbol: 'roc', category: 'time_series', requiresValue: false, requiresBase: false },
  ],
} as const;
```

## Operation Registry (Rust Backend)

```rust
// In src-tauri/src/operation_registry.rs

use std::collections::HashMap;

pub type SingleOpFn = Box<dyn Fn(f64, f64) -> Option<f64> + Send + Sync>;
pub type MultiOpFn = Box<dyn Fn(&[f64]) -> Option<f64> + Send + Sync>;

pub fn build_single_ops() -> HashMap<&'static str, SingleOpFn> {
    let mut ops: HashMap<&'static str, SingleOpFn> = HashMap::new();
    ops.insert("add",      Box::new(|a, b| Some(a + b)));
    ops.insert("subtract", Box::new(|a, b| Some(a - b)));
    ops.insert("multiply", Box::new(|a, b| Some(a * b)));
    ops.insert("divide",   Box::new(|a, b| if b != 0.0 { Some(a / b) } else { None }));
    ops.insert("power",    Box::new(|a, b| Some(a.powf(b))));
    ops.insert("abs",      Box::new(|a, _| Some(a.abs())));
    ops.insert("log10",    Box::new(|a, _| if a > 0.0 { Some(a.log10()) } else { None }));
    ops.insert("sqrt",     Box::new(|a, _| if a >= 0.0 { Some(a.sqrt()) } else { None }));
    ops.insert("round",    Box::new(|a, decimals| {
        let factor = 10_f64.powi(decimals as i32);
        Some((a * factor).round() / factor)
    }));
    ops
}

pub fn build_multi_ops() -> HashMap<&'static str, MultiOpFn> {
    let mut ops: HashMap<&'static str, MultiOpFn> = HashMap::new();
    ops.insert("sum",     Box::new(|vals| Some(vals.iter().sum())));
    ops.insert("mean",    Box::new(|vals| Some(vals.iter().sum::<f64>() / vals.len() as f64)));
    ops.insert("product", Box::new(|vals| Some(vals.iter().product())));
    ops.insert("median",  Box::new(|vals| {
        let mut sorted = vals.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mid = sorted.len() / 2;
        if sorted.len() % 2 == 0 {
            Some((sorted[mid - 1] + sorted[mid]) / 2.0)
        } else {
            Some(sorted[mid])
        }
    }));
    ops
}
```

## New React Hooks

```typescript
// In src/hooks/useCalculationEngine.ts
export function useCalculationEngine(selectedSensors: string[]) {
  // Manages:
  // - calculationMode: 'simple' | 'formula'
  // - simpleConfig: { operationId, value, baseSensor, params }
  // - formulaText: string
  // - customName: string
  // - config: SensorCalculationConfig (derived, ready to send to backend)
  // - previewFormula: string (human-readable formula preview)
  //
  // Functions:
  // - setCalculationMode(mode): toggle between simple and formula
  // - setOperationId(id): set the selected operation (auto-derives from registry)
  // - setValue(val): set the numeric value for single ops
  // - setBaseSensor(sensor): set the base sensor for multi ops
  // - setParam(name, value): set an additional parameter
  // - setFormulaText(text): set the formula expression
  // - setCustomName(name): set custom sensor name
  // - buildConfig(): builds SensorCalculationConfig from current state
}

// In src/hooks/useFormulaEditor.ts
export function useFormulaEditor(availableSensors: string[]) {
  // Manages:
  // - formulaText: string
  // - cursorPosition: number
  // - suggestions: string[] (autocomplete)
  // - showSuggestions: boolean
  // - validationResult: FormulaValidationResult | null
  // - isValidating: boolean
  //
  // Functions:
  // - setFormulaText(text): update formula and trigger validation
  // - insertSensor(sensorName): insert $SensorName at cursor
  // - validateFormula(): call validate_formula command
  // - getSyntaxHighlightedTokens(): returns tokens for display
}
```

## Formula Syntax

```
// Sensor references
$SensorA                    // simple sensor name
${Sensor Name With Spaces}  // sensor name with spaces

// Operators
+  -  *  /  ^  (  )

// Built-in functions
abs(x), sqrt(x), pow(x, n), log(x), log10(x), exp(x)
ceil(x), floor(x), round(x, decimals)
clamp(x, min, max), min(a, b), max(a, b)

// Aggregation functions (across selected sensors)
sum($A, $B, $C), avg($A, $B), median($A, $B, $C), std($A, $B)

// Time-series functions
moving_avg($sensor, window_size)
rate_of_change($sensor)
lag($sensor, periods)

// Examples
= $SensorA + $SensorB * 2
= avg($SensorA, $SensorB, $SensorC)
= abs($SensorA) / max($SensorB, 1)
= sqrt(pow($SensorA, 2) + pow($SensorB, 2))
= clamp($SensorA, 0, 100)
```

## Backward Compatibility

- The existing `SensorOperationConfig` type in `src/types.ts` remains unchanged
- The Rust `calculate_new_sensor` command continues to accept the old config format
- The new `SensorCalculationConfig` is a separate type used only by the new UI
- When the UI sends a simple mode config, it is translated to the existing `SensorOperationConfig` format by the hook before calling `calculate_new_sensor`
- Formula mode uses the new `evaluate_formula` command exclusively
- Existing workspace states with `operationConfig` field continue to work

## Notes

- The operation registry is the SINGLE SOURCE OF TRUTH: adding a new operation requires one entry in `src/config/operations.ts` (frontend) and one `register()` call in `operation_registry.rs` (backend)
- The formula engine uses `fasteval` crate for high-performance expression evaluation
- Formula validation is a separate command from evaluation to enable real-time feedback without modifying data
- Time-series functions (moving_avg, rate_of_change, lag) require sequential row access and cannot be parallelized with rayon
