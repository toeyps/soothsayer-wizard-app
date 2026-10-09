/**
 * Shared types of the special-sensor Formula editor + Quick build (customer
 * batch 2026-10, item 6) -- the TypeScript side of Rust's `preview_formula` /
 * `convert_legacy_formula` (`src-tauri/src/lib.rs`) and of the issue codes in
 * `src-tauri/src/formula_diagnostics.rs`.
 *
 * Keys of both commands keep Tauri's DEFAULT camelCase (no `rename_all`):
 * `{ formula?, aggregate?, maxPoints?, expectedGeneration?, replace?, requestId? }`.
 */

/** Every stable code Rust's formula gate can answer with (the front-end check
 *  uses the same ones -- a fix button is keyed on the code, never the text). */
export type FormulaIssueCode =
    | 'unknown_function'
    | 'unknown_sensor'
    | 'bad_arg_count'
    | 'too_long'
    | 'too_deep'
    | 'unclosed_bracket'
    | 'unmatched_close'
    | 'empty_brackets'
    | 'op_no_left'
    | 'op_no_right'
    | 'missing_operator'
    | 'stray_comma'
    | 'fn_no_bracket'
    | 'constant_only'
    | 'div_zero'
    | 'bad_number'
    | 'bad_char'
    | 'agg_too_few'
    | 'round_excel'
    | 'unknown_operation'
    | 'bad_decimals'
    | 'parse_error';

/** One reason a formula / aggregate block is refused. `range` is `[start, end)`
 *  in UTF-16 code units of the text that was checked (a JS string index /
 *  textarea selection), absent when it could not be located. `code` is typed
 *  as a plain string too, so a code added in Rust later is carried, not lost. */
export interface FormulaIssue {
    code: FormulaIssueCode | (string & {});
    message: string;
    range?: [number, number];
}

/** An Average / Median / Sum block, previewed exactly as `calculate_new_sensor`
 *  (mode `multi`) builds it. `decimals` = `SensorOperationConfig.multiOp.decimals`. */
export interface FormulaPreviewAggregate {
    type: 'mean' | 'median' | 'sum';
    sources: string[];
    decimals?: number | null;
}

/** What to preview: the stored formula text, OR an aggregate block. */
export type FormulaPreviewInput =
    | { formula: string; aggregate?: undefined }
    | { aggregate: FormulaPreviewAggregate; formula?: undefined };

export interface FormulaPreviewStats {
    /** Over the rows that have a value; `null` when none has. */
    min: number | null;
    max: number | null;
    mean: number | null;
    /** Every row of the dataset. */
    rows: number;
    /** Rows without a value (a missing input or a non-finite result). */
    missing: number;
}

export interface FormulaPreviewLimits {
    max_len: number;
    max_depth: number;
}

/** Rust's `FormulaPreview` reply (snake_case field names: Rust serialises them
 *  as declared). A refusal is `ok: false` with `issues`, never a rejection. */
export interface FormulaPreviewResult {
    ok: boolean;
    issues: FormulaIssue[];
    stats: FormulaPreviewStats | null;
    /** Min/max-preserving downsample, both arrays the same length (<= maxPoints). */
    timestamps: string[];
    values: (number | null)[];
    /** `[first, last]` timestamp text of the dataset; `null` when not ok. */
    period: [string, string] | null;
    /** Every engine function name -- the ONLY source of that list in the app. */
    functions: string[];
    limits: FormulaPreviewLimits;
    /** Set only for a `round_excel` refusal whose whole-text conversion passes the gate. */
    converted_formula: string | null;
}

/** Rust's `convert_legacy_formula` reply. */
export interface LegacyFormulaConversionResult {
    formula: string;
    changed: boolean;
}

/** One special sensor whose stored formula was rewritten on workspace open. */
export interface LegacyFormulaConversion {
    tag: string;
    from: string;
    to: string;
}
