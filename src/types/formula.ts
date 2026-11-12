/** Shared types of the Formula editor + Quick build (Rust's `preview_formula` / `convert_legacy_formula`). Both commands keep Tauri's default camelCase keys (no `rename_all`). */

/** Every stable code Rust's formula gate answers with (the front-end check uses the same); key a fix button on the code, never the text. */
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
    | 'removed_function'
    | 'unknown_operation'
    | 'bad_decimals'
    | 'parse_error';

/** One reason a formula/block is refused. `range` is `[start, end)` in UTF-16 units of the checked text, absent when not locatable. `code` also accepts a plain string. */
export interface FormulaIssue {
    code: FormulaIssueCode | (string & {});
    message: string;
    range?: [number, number];
}

/** An Average/Median/Sum block, previewed as `calculate_new_sensor` (mode `multi`) builds it. `decimals` = `SensorOperationConfig.multiOp.decimals`. */
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

/** Rust's `FormulaPreview` reply (snake_case, as declared). A refusal is `ok: false` with `issues`, never a rejection. */
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
