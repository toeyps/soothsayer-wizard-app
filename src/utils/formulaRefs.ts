/** TS twin of Rust's scan_sensor_refs (lib.rs), for DISPLAY only; dependencies and renames still ask Rust. Grammar: `${Up To First Brace}` (empty or unclosed names nothing); `$Name` starts alphanumeric/`_` and continues alphanumeric/`_`/`.` (`$11PT1214A.PV` is one sensor, `$Total-Power` is `Total` minus something). Unicode Alphabetic || Numeric, as in Rust. */
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
