/* The app's one date format; no other code in `src/` builds a date string by hand. Numerals, zero-padded, 24-hour; never a month name or the PC locale (`toLocaleDateString()` gives MM/DD/YYYY under en-US). */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** How much of a date-and-time is printed. */
export type DatePrecision = 'date' | 'minutes' | 'seconds';

/** The fields of a wall clock (month 1–12) — what a clock on the wall shows,
 *  with no time zone attached. */
export interface WallClock {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

/** The one place a date string is assembled: `2025/03/14`, `2025/03/14 21:25`
 *  or `2025/03/14 21:25:00` (the default). */
export function formatWallClock(w: WallClock, precision: DatePrecision = 'seconds'): string {
    const date = `${w.year}/${pad2(w.month)}/${pad2(w.day)}`;
    if (precision === 'date') return date;
    const clock = `${pad2(w.hour)}:${pad2(w.minute)}`;
    return precision === 'minutes' ? `${date} ${clock}` : `${date} ${clock}:${pad2(w.second)}`;
}

/** A `Date`'s wall clock in the PC's own time zone. */
export function wallClockOf(d: Date): WallClock {
    return {
        year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
        hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
    };
}

/** YYYY/MM/DD — a date alone. */
export function formatDate(d: Date): string {
    return formatWallClock(wallClockOf(d), 'date');
}

/** YYYY/MM/DD HH:mm:ss, 24-hour clock — a data row's time. */
export function formatDateTime(d: Date): string {
    return formatWallClock(wallClockOf(d), 'seconds');
}

/** YYYY/MM/DD HH:mm, 24-hour, no seconds: a period bound the user typed or an instant the app recorded. */
export function formatDateTimeMinutes(d: Date): string {
    return formatWallClock(wallClockOf(d), 'minutes');
}

/** YYYY/MM — month and year, where a full date does not fit. */
export function formatYearMonth(d: Date): string {
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}`;
}

/** HH:mm, 24-hour clock — a time with no date. */
export function formatClock(d: Date): string {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYY-MM-DD[ T]HH:MM[:SS[.fff]]` (or with `/`) and an optional `Z` / `+07:00`. */
const ROW_TIME_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Wall clock written in a timestamp text, read from its digits, so any offset or Z is ignored; date only = 00:00:00, else `null`. */
export function readWallClock(text: string): WallClock | null {
    const m = ROW_TIME_RE.exec(text.trim());
    if (!m) return null;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return {
        year: Number(m[1]), month, day: Number(m[3]),
        hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0),
    };
}

/** A data row's own wall-clock time (see `readWallClock`) formatted to `precision`; `null` if the text isn't a usual timestamp. */
export function formatRowTime(text: string, precision: DatePrecision = 'seconds'): string | null {
    const w = readWallClock(text);
    return w ? formatWallClock(w, precision) : null;
}

/** Time-axis tick label (epoch ms, PC time zone): date at midnight, else date + time, adding seconds/ms only when finer. Date-only labels would repeat when zoomed to a day or less. */
export function formatAxisTick(value: number): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const ms = d.getMilliseconds();
    if (ms !== 0) return `${formatDateTime(d)}.${String(ms).padStart(3, '0')}`;
    if (d.getSeconds() !== 0) return formatDateTime(d);
    if (d.getHours() !== 0 || d.getMinutes() !== 0) return formatDateTimeMinutes(d);
    return formatDate(d);
}
