/**
 * Which sensors a formula names -- the TypeScript twin of Rust's
 * `scan_sensor_refs` (`src-tauri/src/lib.rs`), used for DISPLAY only (the
 * "Referenced sensors" chips under the Create formula box). Anything that
 * decides behaviour (dependencies, renames) still asks Rust
 * (`extract_formula_refs` / `rename_formula_refs`).
 *
 * Grammar, exactly as Rust scans it:
 *   - `${Anything Up To The First Brace}` -- an empty `${}` or an unclosed
 *     `${` names nothing;
 *   - `$Name` -- starts with an alphanumeric or `_`, then runs while the
 *     characters are alphanumeric, `_` or `.` (so `$11PT1214A.PV` is ONE
 *     sensor, and `$Total-Power` is `Total` minus something).
 * Rust's `char::is_alphanumeric` is Unicode `Alphabetic || Numeric`, hence
 * `\p{Alphabetic}` / `\p{N}` (a bare Thai name like `$อุณหภูมิ` is one name).
 */
const REF = /\$\{([^}]+)\}|\$([\p{Alphabetic}\p{N}_][\p{Alphabetic}\p{N}_.]*)/gu;

/** Distinct sensor names in order of first appearance. */
export function formulaRefNames(formula: string): string[] {
    const names: string[] = [];
    for (const m of formula.matchAll(REF)) {
        const name = m[1] ?? m[2];
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}
