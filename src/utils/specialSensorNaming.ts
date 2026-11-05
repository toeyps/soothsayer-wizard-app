/** Naming rules for creating, renaming or referencing a special sensor; `specialSensorNaming.test.ts` pins the shared table. Reference rule must match Rust's `sensor_ref_token`: bare `$Name` only when every char is alphanumeric or `_`, else `${Name}`. */

/** Tags compare case-insensitively, ignoring surrounding whitespace, as elsewhere (byTag maps, specialSensorDeps, Rust). */
export const sameTag = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

/** JS twin of Rust's char::is_alphanumeric: `\p{Alphabetic}` + `\p{N}`, not `\p{L}` (would brace Thai vowel marks). */
const BARE_NAME = /^[\p{Alphabetic}\p{N}_]+$/u;

/** How a sensor is written inside a formula: bare `$Name` when that parses
 *  back to exactly this name, `${Name}` otherwise. */
export function sensorRef(tag: string): string {
    return BARE_NAME.test(tag) ? `$${tag}` : `\${${tag}}`;
}

/** Possible time-column names, refused here since the window isn't told the real header; Rust catches other collisions. */
const RESERVED_TAGS = ['timestamp', 'time'];

/** Why `name` can't be used for a NEW special sensor, or null. Empty is not a conflict (the form reports required fields). `takenTags` = every known tag, imported and special. */
export function nameProblem(name: string, takenTags: Iterable<string>): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    // A `}` can't be written in either reference form (it ends the name): refuse at naming time.
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
