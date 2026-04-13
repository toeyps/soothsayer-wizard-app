import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FormulaValidationResult } from '../types/calculationEngine';

export interface UseFormulaEditorReturn {
  formula: string;
  setFormula: (value: string, cursorPos?: number) => void;
  validationResult: FormulaValidationResult | null;
  isValidating: boolean;
  referencedSensors: string[];
  // Autocomplete
  showAutocomplete: boolean;
  setShowAutocomplete: (show: boolean) => void;
  suggestions: string[];
  insertSensor: (sensorName: string) => void;
  cursorPosition: number;
  setCursorPosition: (pos: number) => void;
}

/**
 * Hook for formula editor state, autocomplete, and validation.
 *
 * Features:
 * - Debounced validation via the `validate_formula` Tauri command
 * - Sensor reference extraction from `$SensorName` and `${Sensor Name}` tokens
 * - Autocomplete suggestions triggered by the `$` character
 * - Sensor insertion at cursor position with automatic brace wrapping
 *   for names containing spaces or dots
 */
export function useFormulaEditor(
  availableSensors: string[],
): UseFormulaEditorReturn {
  const [formula, setFormulaRaw] = useState('');
  const [validationResult, setValidationResult] =
    useState<FormulaValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extract sensor references from the formula text.
  // Supports both $SensorName and ${Sensor Name With Spaces} syntax.
  const referencedSensors = useMemo(() => {
    const matches = formula.matchAll(/\$\{([^}]+)\}|\$(\w+)/g);
    const sensors: string[] = [];
    for (const match of matches) {
      sensors.push(match[1] || match[2]);
    }
    return [...new Set(sensors)];
  }, [formula]);

  // Filtered autocomplete suggestions based on the partial text after $
  const suggestions = useMemo(() => {
    if (!autocompleteFilter) return availableSensors.slice(0, 20);
    const lower = autocompleteFilter.toLowerCase();
    return availableSensors
      .filter((s) => s.toLowerCase().includes(lower))
      .slice(0, 20);
  }, [availableSensors, autocompleteFilter]);

  // Validate formula via Tauri backend command
  const validate = useCallback(async (expr: string) => {
    if (!expr.trim()) {
      setValidationResult(null);
      return;
    }
    setIsValidating(true);
    try {
      const result = await invoke<FormulaValidationResult>(
        'validate_formula',
        { formula: expr },
      );
      setValidationResult(result);
    } catch (err) {
      setValidationResult({
        valid: false,
        error: String(err),
        referenced_sensors: [],
      });
    } finally {
      setIsValidating(false);
    }
  }, []);

  // Handle formula change with autocomplete detection and debounced validation
  const handleFormulaChange = useCallback(
    (value: string, cursorPos?: number) => {
      setFormulaRaw(value);
      if (cursorPos !== undefined) setCursorPosition(cursorPos);

      // Check if user just typed '$' -- trigger autocomplete
      if (cursorPos !== undefined) {
        const beforeCursor = value.substring(0, cursorPos);
        const dollarMatch = beforeCursor.match(/\$(\w*)$/);
        if (dollarMatch) {
          setShowAutocomplete(true);
          setAutocompleteFilter(dollarMatch[1] || '');
        } else {
          setShowAutocomplete(false);
          setAutocompleteFilter('');
        }
      }

      // Debounce validation to avoid excessive backend calls
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => validate(value), 500);
    },
    [validate],
  );

  // Insert a sensor name at the current cursor position, replacing any
  // partial $text that triggered the autocomplete
  const insertSensor = useCallback(
    (sensorName: string) => {
      const beforeCursor = formula.substring(0, cursorPosition);
      const afterCursor = formula.substring(cursorPosition);

      // Replace the $partial with the full sensor reference
      const dollarMatch = beforeCursor.match(/\$(\w*)$/);
      const insertStart = dollarMatch
        ? cursorPosition - dollarMatch[0].length
        : cursorPosition;

      const needsBraces = sensorName.includes(' ') || sensorName.includes('.');
      const insertion = needsBraces
        ? `\${${sensorName}}`
        : `$${sensorName}`;

      const newFormula =
        formula.substring(0, insertStart) + insertion + afterCursor;
      setFormulaRaw(newFormula);
      setShowAutocomplete(false);
      setAutocompleteFilter('');

      // Trigger validation for the updated formula
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => validate(newFormula), 300);
    },
    [formula, cursorPosition, validate],
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  return {
    formula,
    setFormula: handleFormulaChange,
    validationResult,
    isValidating,
    referencedSensors,
    // Autocomplete
    showAutocomplete,
    setShowAutocomplete,
    suggestions,
    insertSensor,
    cursorPosition,
    setCursorPosition,
  };
}
