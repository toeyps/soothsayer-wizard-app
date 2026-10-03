/**
 * Naming rules shared by everything that creates, renames or references a
 * special sensor: tag comparison, how a tag is written inside a formula, and
 * which names are refused up front.
 *
 * The formula-reference rule MUST stay identical to Rust's `sensor_ref_token`
 * in `src-tauri/src/lib.rs` (a bare `$Name` only when every character is
 * alphanumeric or `_`, `${Name}` otherwise). Both sides parse either form, so
 * a mismatch would not break evaluation -- but a formula text built here and
 * the one `rename_formula_refs` rewrites in Rust would then disagree about
 * how the same sensor is spelled. `specialSensorNaming.test.ts` pins the same
 * table of names the Rust tests use.
 */

/** Tag comparison is case-insensitive and ignores surrounding whitespace
 *  everywhere else this app matches sensor tags (Dashboard's `byTag` maps,
 *  `specialSensorDeps`, and Rust's `resolve_sensor`). */
export const sameTag = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Rust's `char::is_alphanumeric` is `Alphabetic || Numeric`. The JS twin is
 * `\p{Alphabetic}` plus `\p{N}` -- deliberately NOT `\p{L}`, which would
 * brace names Rust leaves bare (Thai vowel marks such as the one in
 * "อุณหภูมิ" are Alphabetic but not letters).
 */
const BARE_NAME = /^[\p{Alphabetic}\p{N}_]+$/u;

/** How a sensor is written inside a formula: bare `$Name` when that parses
 *  back to exactly this name, `${Name}` otherwise. */
export function sensorRef(tag: string): string {
    return BARE_NAME.test(tag) ? `$${tag}` : `\${${tag}}`;
}

/** Columns the dataset's own time axis can be called. The window is not told
 *  the real timestamp header, so these two (the names the rest of the app
 *  already treats as "the time column") are refused here; anything else that
 *  collides is caught by Rust's own "already exists" check. */
const RESERVED_TAGS = ['timestamp', 'time'];

/**
 * Why `name` can't be used for a NEW special sensor, or null when it can.
 * An empty name is not a problem here -- "a name is required" is reported by
 * the form's missing-fields check, not as a conflict.
 *
 * `takenTags` is every sensor tag the caller knows about (imported columns and
 * existing special sensors alike).
 */
export function nameProblem(name: string, takenTags: Iterable<string>): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    // A `}` can't be written in either reference form: `${A}B}` ends at the
    // first `}`, and the bare form stops at it. Refuse at naming time rather
    // than let a formula silently lose part of the name.
    if (trimmed.includes('}')) {
        return `A sensor name can't contain "}" -- formulas have no way to refer to it.`;
    }
    if (RESERVED_TAGS.includes(trimmed.toLowerCase())) {
        return `"${trimmed}" is reserved for the time column. Pick another name.`;
    }
    for (const tag of takenTags) {
        if (sameTag(tag, trimmed)) {
            return `A sensor named "${tag.trim()}" already exists. Pick another name.`;
        }
    }
    return null;
}
