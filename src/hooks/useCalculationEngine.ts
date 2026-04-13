import { useState, useCallback, useMemo } from 'react';
import type { SensorCalculationConfig } from '../types/calculationEngine';
import type { SensorOperationConfig, SingleOperationType, MultiOperationType } from '../types';
import { OPERATIONS, findOperation } from '../config/operations';

export interface UseCalculationEngineReturn {
  // Mode
  calcMode: 'simple' | 'formula';
  setCalcMode: (mode: 'simple' | 'formula') => void;
  // Simple mode state
  simpleType: 'single' | 'multi';
  setSimpleType: (type: 'single' | 'multi') => void;
  operationId: string;
  setOperationId: (id: string) => void;
  value: number;
  setValue: (v: number) => void;
  baseSensor: string;
  setBaseSensor: (sensor: string) => void;
  params: Record<string, number>;
  setParams: (p: Record<string, number>) => void;
  customName: string;
  setCustomName: (name: string) => void;
  // Formula mode state
  formula: string;
  setFormula: (f: string) => void;
  // Derived
  currentOperation: ReturnType<typeof findOperation>;
  preview: string;
  // Builders
  buildConfig: () => SensorCalculationConfig;
  buildLegacyConfig: () => SensorOperationConfig | null;
}

/**
 * Hook managing the hybrid calculation engine state.
 *
 * Supports two modes:
 * - **simple**: Registry-driven dropdowns (single-sensor or multi-sensor operations)
 * - **formula**: Free-form formula expression with $SensorName references
 *
 * Provides both the new `SensorCalculationConfig` and a backward-compatible
 * `SensorOperationConfig` builder for operations supported by the legacy
 * `calculate_new_sensor` command.
 */
export function useCalculationEngine(
  selectedSensors: string[],
): UseCalculationEngineReturn {
  const [calcMode, setCalcMode] = useState<'simple' | 'formula'>('simple');

  // Simple mode state
  const [simpleType, setSimpleTypeRaw] = useState<'single' | 'multi'>('single');
  const [operationId, setOperationId] = useState<string>('add');
  const [value, setValue] = useState<number>(0);
  const [baseSensor, setBaseSensor] = useState<string>('');
  const [params, setParams] = useState<Record<string, number>>({});
  const [customName, setCustomName] = useState<string>('');

  // Formula mode state
  const [formula, setFormula] = useState<string>('');

  const currentOperation = useMemo(() => {
    return findOperation(simpleType, operationId);
  }, [simpleType, operationId]);

  // Build a human-readable preview string for the current configuration
  const preview = useMemo(() => {
    if (calcMode === 'formula') return formula;
    if (!currentOperation || selectedSensors.length === 0) return '';

    if (simpleType === 'single') {
      const sensor = selectedSensors[0] || 'Sensor';
      if (currentOperation.requiresValue) {
        return `${sensor} ${currentOperation.symbol} ${value}`;
      }
      return `${currentOperation.symbol}(${sensor})`;
    } else {
      const op = currentOperation;
      if (op.requiresBase) {
        const base = baseSensor || selectedSensors[0];
        const others = selectedSensors.filter((s) => s !== base).join(', ');
        return `${base} ${op.symbol} (${others})`;
      }
      return `${op.symbol}(${selectedSensors.join(', ')})`;
    }
  }, [calcMode, formula, currentOperation, simpleType, selectedSensors, value, baseSensor]);

  /**
   * Build the legacy `SensorOperationConfig` for backward compatibility with
   * the existing `calculate_new_sensor` Tauri command.
   *
   * Returns `null` when the current operation is not supported by the legacy
   * command (e.g., transform operations like abs, log10, sqrt, or time-series
   * operations like moving_avg, rate_of_change).
   */
  const buildLegacyConfig = useCallback((): SensorOperationConfig | null => {
    if (calcMode !== 'simple') return null;

    if (simpleType === 'single') {
      const legacySingleOps: string[] = ['add', 'subtract', 'multiply', 'divide', 'power'];
      if (!legacySingleOps.includes(operationId)) return null;
      return {
        mode: 'single',
        singleOp: { type: operationId as SingleOperationType, value },
        customName: customName || undefined,
      };
    } else {
      const legacyMultiOps: string[] = ['sum', 'mean', 'median', 'product', 'subtract', 'divide'];
      if (!legacyMultiOps.includes(operationId)) return null;
      return {
        mode: 'multi',
        multiOp: {
          type: operationId as MultiOperationType,
          baseSensor:
            operationId === 'subtract' || operationId === 'divide'
              ? baseSensor
              : undefined,
        },
        customName: customName || undefined,
      };
    }
  }, [calcMode, simpleType, operationId, value, baseSensor, customName]);

  /**
   * Build the new unified `SensorCalculationConfig` for both simple and
   * formula modes. This is the forward-looking config format.
   */
  const buildConfig = useCallback((): SensorCalculationConfig => {
    if (calcMode === 'formula') {
      return {
        mode: 'formula',
        formula: { expression: formula },
        customName: customName || undefined,
      };
    }
    return {
      mode: 'simple',
      simple: {
        operationId,
        sensors: selectedSensors,
        value: currentOperation?.requiresValue ? value : undefined,
        baseSensor: currentOperation?.requiresBase ? baseSensor : undefined,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
      customName: customName || undefined,
    };
  }, [
    calcMode,
    formula,
    operationId,
    selectedSensors,
    value,
    baseSensor,
    params,
    customName,
    currentOperation,
  ]);

  // Reset operation-specific state when switching between single and multi
  const handleSimpleTypeChange = useCallback((type: 'single' | 'multi') => {
    setSimpleTypeRaw(type);
    setOperationId(OPERATIONS[type][0].id);
    setValue(0);
    setParams({});
  }, []);

  return {
    // Mode
    calcMode,
    setCalcMode,
    // Simple
    simpleType,
    setSimpleType: handleSimpleTypeChange,
    operationId,
    setOperationId,
    value,
    setValue,
    baseSensor,
    setBaseSensor,
    params,
    setParams,
    customName,
    setCustomName,
    // Formula
    formula,
    setFormula,
    // Derived
    currentOperation,
    preview,
    // Builders
    buildConfig,
    buildLegacyConfig,
  };
}
