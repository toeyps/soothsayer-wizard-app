import { useState, useCallback, useMemo } from 'react';
import type { SensorOperationConfig, SingleOperationType, MultiOperationType } from '../types';
import { findOperation } from '../config/operations';

/** Legacy multi-sensor ops the Rust `calculate_new_sensor` command handles natively. */
const LEGACY_MULTI_IDS = new Set(['sum', 'mean', 'median', 'product', 'subtract', 'divide']);
/**
 * New multi-sensor shortcuts built as a formula string and sent to
 * `evaluate_formula` instead. Exported so the UI can tell which shortcuts
 * support "Then apply to the result" wrapping (only formula-backed results
 * can be wrapped -- a legacy `calculate_new_sensor` config has no
 * post-processing step).
 */
export const FORMULA_MULTI_IDS = new Set(['abs_diff', 'temp_spread', 'efficiency_pct']);
/** Multi-sensor ops (of either kind) that need one selected sensor marked as the "starting value". */
const NEEDS_BASE_SENSOR = new Set(['subtract', 'divide', 'efficiency_pct']);

const CHAIN_SYMBOL_TO_FASTEVAL: Record<string, string> = { '+': '+', '−': '-', '×': '*', '÷': '/' };

/** What clicking "Add sensor" should actually do. */
export type CalcBuildResult =
  | { kind: 'none' }
  | { kind: 'legacy'; config: SensorOperationConfig }
  | { kind: 'formula'; expression: string };

export interface UseCalculationEngineReturn {
  // Mode: pick an operation from buttons, or type a raw formula
  mode: 'buttons' | 'formula';
  setMode: (mode: 'buttons' | 'formula') => void;
  // Which operation group applies -- derived from how many sensors are selected
  opGroup: 'single' | 'multi';
  // The chosen shortcut id, or null for "add sensor(s) as-is, no calculation".
  // Mutually exclusive with the operator chain (picking one clears the other).
  operationId: string | null;
  setOperationId: (id: string | null) => void;
  // Shared numeric input -- the value to combine with for arithmetic ops,
  // or the decimal count for "round"
  value: number;
  setValue: (v: number) => void;
  // Which selected sensor is the "starting value" for subtract/divide/efficiency
  baseSensor: string;
  setBaseSensor: (sensor: string) => void;
  // "Combine with operators" chain -- one operator symbol between each
  // consecutive pair of selected sensors, built into a formula. This is the
  // default multi-sensor calculation whenever no shortcut (`operationId`)
  // is chosen -- see `build()`.
  chainOps: string[];
  setChainOp: (index: number, symbol: string) => void;
  // Post-processing applied to the chain or a formula-based shortcut's result
  wrapFunc: string | null;
  setWrapFunc: (id: string | null) => void;
  wrapValue: number;
  setWrapValue: (v: number) => void;
  customName: string;
  setCustomName: (name: string) => void;
  // Derived
  currentOperation: ReturnType<typeof findOperation>;
  // Builders
  build: () => CalcBuildResult;
}

function sensorRef(tag: string): string {
  const needsBraces = tag.includes(' ') || tag.includes('.');
  return needsBraces ? `\${${tag}}` : `$${tag}`;
}

/**
 * Wrap an already-built expression with a "Then apply to the result"
 * transform. `sqrt`/`exp`/`log10` are custom functions the Rust side
 * resolves via fasteval's namespace callback (see `eval_extra_math_fn` in
 * `lib.rs`) -- fasteval's own builtins don't include them.
 */
function applyWrap(expr: string, funcId: string | null, decimals: number): string {
  switch (funcId) {
    case 'abs':
    case 'sqrt':
    case 'log10':
    case 'exp':
    case 'ceil':
    case 'floor':
      return `${funcId}(${expr})`;
    case 'round': {
      // fasteval's round(modulus, x) rounds to the nearest multiple of
      // modulus, not "N decimal places" -- convert.
      const modulus = Math.pow(10, -decimals);
      return `round(${modulus}, ${expr})`;
    }
    default:
      return expr;
  }
}

/**
 * Hook managing button-driven calculation state for the Add Special Sensor
 * window.
 *
 * Which operations are offered is derived from `selectedSensors.length`
 * (1 sensor -> single-sensor ops, 2+ -> combine ops) rather than a
 * user-facing mode toggle, so there's nothing to pick wrong before getting
 * to the actual operations.
 *
 * For multi-sensor calculations there are two mutually-exclusive ways to
 * build a result: a `chain` of operators between each selected sensor, or a
 * one-click `operationId` shortcut (aggregate, "compare one against the
 * rest", or a named formula like Absolute Difference / Spread /
 * Efficiency %). Shortcuts backed by the Rust `calculate_new_sensor`
 * command build a `SensorOperationConfig`; everything else (the chain, and
 * the newer named shortcuts) builds a formula string for `evaluate_formula`
 * instead -- both are real Tauri commands already wired up in
 * `AddSensorWindow.tsx`.
 */
export function useCalculationEngine(
  selectedSensors: string[],
): UseCalculationEngineReturn {
  const [mode, setMode] = useState<'buttons' | 'formula'>('buttons');
  const [operationId, setOperationIdRaw] = useState<string | null>(null);
  const [value, setValue] = useState<number>(0);
  const [baseSensor, setBaseSensor] = useState<string>('');
  const [chainOps, setChainOps] = useState<string[]>([]);
  const [wrapFunc, setWrapFunc] = useState<string | null>(null);
  const [wrapValue, setWrapValue] = useState<number>(2);
  const [customName, setCustomName] = useState<string>('');

  const opGroup: 'single' | 'multi' = selectedSensors.length <= 1 ? 'single' : 'multi';

  const currentOperation = useMemo(() => {
    return operationId ? findOperation(opGroup, operationId) : undefined;
  }, [opGroup, operationId]);

  const setOperationId = useCallback(
    (id: string | null) => {
      setOperationIdRaw(id);
      setValue(id === 'round' ? 2 : 0);
      if (id !== null && NEEDS_BASE_SENSOR.has(id)) {
        setBaseSensor((prev) =>
          selectedSensors.includes(prev) ? prev : selectedSensors[0] ?? ''
        );
      }
    },
    [selectedSensors],
  );

  const setChainOp = useCallback((index: number, symbol: string) => {
    setChainOps((prev) => {
      const next = [...prev];
      next[index] = symbol;
      return next;
    });
    // Picking a chain operator explicitly opts out of any "Combine all" /
    // "Compare one against the rest" shortcut.
    setOperationIdRaw(null);
    setBaseSensor('');
  }, []);

  const build = useCallback((): CalcBuildResult => {
    if (mode !== 'buttons') return { kind: 'none' };

    if (opGroup === 'single') {
      if (!operationId) return { kind: 'none' };
      return {
        kind: 'legacy',
        config: {
          mode: 'single',
          singleOp: { type: operationId as SingleOperationType, value },
          customName: customName || undefined,
        },
      };
    }

    // Multi-sensor. selectedSensors.length is always >= 2 here (opGroup is
    // 'single' below that threshold).
    if (operationId) {
      if (LEGACY_MULTI_IDS.has(operationId)) {
        const needsBase = NEEDS_BASE_SENSOR.has(operationId);
        return {
          kind: 'legacy',
          config: {
            mode: 'multi',
            multiOp: {
              type: operationId as MultiOperationType,
              baseSensor: needsBase ? baseSensor || selectedSensors[0] : undefined,
            },
            customName: customName || undefined,
          },
        };
      }

      if (FORMULA_MULTI_IDS.has(operationId)) {
        let expr: string;
        if (operationId === 'abs_diff') {
          expr = `abs(${sensorRef(selectedSensors[0])} - ${sensorRef(selectedSensors[1])})`;
        } else if (operationId === 'temp_spread') {
          const refs = selectedSensors.map(sensorRef).join(', ');
          expr = `max(${refs}) - min(${refs})`;
        } else {
          // efficiency_pct: (output / input) * 100
          const input = baseSensor || selectedSensors[0];
          const output = selectedSensors.find((s) => s !== input) ?? selectedSensors[1];
          expr = `(${sensorRef(output)} / ${sensorRef(input)}) * 100`;
        }
        return { kind: 'formula', expression: applyWrap(expr, wrapFunc, wrapValue) };
      }
    }

    // No shortcut chosen -- the operator chain (defaulting to "+" between
    // every sensor, exactly as already shown in "Combine with operators")
    // IS the calculation. This is deliberately not gated behind `useChain`:
    // that display was previously cosmetic-only, so picking no shortcut and
    // clicking "Add sensor" silently re-added the same raw sensors
    // unchanged, with no visible sign that nothing new had been created.
    let expr = sensorRef(selectedSensors[0]);
    for (let i = 0; i < selectedSensors.length - 1; i++) {
      const symbol = CHAIN_SYMBOL_TO_FASTEVAL[chainOps[i] ?? '+'] ?? '+';
      expr += ` ${symbol} ${sensorRef(selectedSensors[i + 1])}`;
    }
    return { kind: 'formula', expression: applyWrap(expr, wrapFunc, wrapValue) };
  }, [
    mode,
    opGroup,
    operationId,
    value,
    baseSensor,
    chainOps,
    wrapFunc,
    wrapValue,
    selectedSensors,
    customName,
  ]);

  return {
    mode,
    setMode,
    opGroup,
    operationId,
    setOperationId,
    value,
    setValue,
    baseSensor,
    setBaseSensor,
    chainOps,
    setChainOp,
    wrapFunc,
    setWrapFunc,
    wrapValue,
    setWrapValue,
    customName,
    setCustomName,
    currentOperation,
    build,
  };
}
