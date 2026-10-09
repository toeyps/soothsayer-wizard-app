import { useState, useCallback, useMemo } from 'react';
import type { FormulaValidationResult } from '../types/calculationEngine';
import { sensorRef } from '../utils/specialSensorNaming';
import { formulaRefNames } from '../utils/formulaRefs';
import { useFormulaValidation, formulaIssue as issueFor } from './useFormulaValidation';

// The `$partial` text right before the cursor that autocomplete replaces.
// Unicode-aware: a Thai or other non-ASCII sensor name is a valid bare ref too.
const PARTIAL_REF = /\$([\p{Alphabetic}\p{N}_]*)$/u;

export interface UseFormulaEditorReturn {
  formula: string;
  setFormula: (value: string, cursorPos?: number) => void;
  validationResult: FormulaValidationResult | null;
  isValidating: boolean;
  /** Why the CURRENT text can't be used (its own finished check said so), or
   *  null -- valid, or not checked yet. Callers block Add on it. */
  formulaIssue: string | null;
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
  options: { generation?: number } = {},
): UseFormulaEditorReturn {
  const [formula, setFormulaRaw] = useState('');
  // Pinned to the window's dataset generation, like the Manage editor's check:
  // a window left over from another project never checks against its columns.
  const { validated, isValidating, schedule } = useFormulaValidation({ generation: options.generation });
  const validationResult = validated?.result ?? null;
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);

  // Sensor references in the formula text, by the SAME grammar Rust's
  // `scan_sensor_refs` uses (dots and non-ASCII letters included) -- see
  // `utils/formulaRefs.ts`.
  const referencedSensors = useMemo(() => formulaRefNames(formula), [formula]);

  // Filtered autocomplete suggestions based on the partial text after $
  const suggestions = useMemo(() => {
    if (!autocompleteFilter) return availableSensors.slice(0, 20);
    const lower = autocompleteFilter.toLowerCase();
    return availableSensors
      .filter((s) => s.toLowerCase().includes(lower))
      .slice(0, 20);
  }, [availableSensors, autocompleteFilter]);

  // Handle formula change with autocomplete detection and debounced validation
  const handleFormulaChange = useCallback(
    (value: string, cursorPos?: number) => {
      setFormulaRaw(value);
      if (cursorPos !== undefined) setCursorPosition(cursorPos);

      // Check if user just typed '$' -- trigger autocomplete
      if (cursorPos !== undefined) {
        const beforeCursor = value.substring(0, cursorPos);
        const dollarMatch = beforeCursor.match(PARTIAL_REF);
        if (dollarMatch) {
          setShowAutocomplete(true);
          setAutocompleteFilter(dollarMatch[1] || '');
        } else {
          setShowAutocomplete(false);
          setAutocompleteFilter('');
        }
      }

      // Debounce validation to avoid excessive backend calls
      schedule(value, 500);
    },
    [schedule],
  );

  // Insert a sensor name at the current cursor position, replacing any
  // partial $text that triggered the autocomplete
  const insertSensor = useCallback(
    (sensorName: string) => {
      const beforeCursor = formula.substring(0, cursorPosition);
      const afterCursor = formula.substring(cursorPosition);

      // Replace the $partial with the full sensor reference
      const dollarMatch = beforeCursor.match(PARTIAL_REF);
      const insertStart = dollarMatch
        ? cursorPosition - dollarMatch[0].length
        : cursorPosition;

      // Same spelling rule the button builder and Rust use (see
      // `utils/specialSensorNaming.ts`) -- not just spaces/dots: `-`, `/`,
      // `%`, parentheses ... all need the braced form too.
      const insertion = sensorRef(sensorName);

      const newFormula =
        formula.substring(0, insertStart) + insertion + afterCursor;
      setFormulaRaw(newFormula);
      setShowAutocomplete(false);
      setAutocompleteFilter('');

      // Trigger validation for the updated formula
      schedule(newFormula, 300);
    },
    [formula, cursorPosition, schedule],
  );

  return {
    formula,
    setFormula: handleFormulaChange,
    validationResult,
    isValidating,
    formulaIssue: issueFor(formula, validated),
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
