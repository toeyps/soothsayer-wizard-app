import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FormulaValidationResult } from '../types/calculationEngine';
import { bindToGeneration, isStaleSessionText, StaleSessionError } from '../utils/staleSession';

/** One finished `validate_formula` round trip, tagged with the text it checked. */
export interface ValidatedFormula {
  formula: string;
  result: FormulaValidationResult;
}

export interface UseFormulaValidationReturn {
  /** The latest finished check (for whatever text was current when it ran). */
  validated: ValidatedFormula | null;
  /** True while a `validate_formula` call is in flight. */
  isValidating: boolean;
  /** Validate `expr` after `delayMs` (debounced: a newer call replaces an older one). */
  schedule: (expr: string, delayMs: number) => void;
}

/** A reply that doesn't look like a `FormulaValidationResult` (a mock, an
 *  old backend) is "no information", never "invalid". */
function isValidationResult(x: unknown): x is FormulaValidationResult {
  return !!x && typeof x === 'object' && typeof (x as { valid?: unknown }).valid === 'boolean';
}

/**
 * Debounced `validate_formula` calls shared by the Create formula editor
 * (`useFormulaEditor`) and the Manage tab's edit form (`SpecialSensorEditor`).
 *
 * Each result is stored WITH the text it validated, and a reply that arrives
 * after a newer request was scheduled is dropped -- so a slow answer for an
 * old text can never mark the current text valid or invalid. Callers decide
 * what the current text's state is with `formulaIssue()`.
 */
export interface UseFormulaValidationOptions {
  /** The Rust dataset generation the caller is bound to. Sent as
   *  `expectedGeneration`, so a window left over from another project checks
   *  nothing against the wrong columns; Rust then answers STALE_SESSION, which
   *  is "no information" here -- never a red formula error. Omitted = the
   *  check is not pinned (old behaviour). */
  generation?: number;
}

export function useFormulaValidation(options: UseFormulaValidationOptions = {}): UseFormulaValidationReturn {
  const generationRef = useRef(options.generation);
  generationRef.current = options.generation;
  const [validated, setValidated] = useState<ValidatedFormula | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (expr: string, mySeq: number) => {
    setIsValidating(true);
    let result: FormulaValidationResult | null;
    try {
      const call = bindToGeneration((cmd, args) => invoke<unknown>(cmd, args), generationRef.current);
      const reply = await call('validate_formula', { formula: expr });
      result = isValidationResult(reply) ? reply : null;
    } catch (err) {
      // The dataset this caller is bound to is gone: that says nothing about
      // the formula itself (the window's own stale-session handling covers it).
      result = err instanceof StaleSessionError || isStaleSessionText(err)
        ? null
        : { valid: false, error: err instanceof Error ? err.message : String(err), referenced_sensors: [] };
    }
    if (mySeq !== seq.current) return; // a newer text was scheduled meanwhile
    setIsValidating(false);
    setValidated(result ? { formula: expr, result } : null);
  }, []);

  const schedule = useCallback((expr: string, delayMs: number) => {
    if (timer.current) clearTimeout(timer.current);
    const mySeq = ++seq.current;
    if (!expr.trim()) {
      timer.current = null;
      setIsValidating(false);
      setValidated(null);
      return;
    }
    timer.current = setTimeout(() => { void run(expr, mySeq); }, delayMs);
  }, [run]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++; // drop any reply still in flight after unmount
  }, []);

  return { validated, isValidating, schedule };
}

/**
 * Why `formula` can't be used, from the latest finished check -- or null when
 * it was found valid, has not been checked yet, or the check is for a
 * different (older) text. "Not checked yet" deliberately does not block: the
 * backend refuses a bad formula on Save/Add anyway, with the same message.
 */
export function formulaIssue(formula: string, validated: ValidatedFormula | null): string | null {
  if (!validated || validated.result.valid) return null;
  if (validated.formula !== formula) return null;
  return validated.result.error || 'This formula is not valid.';
}
