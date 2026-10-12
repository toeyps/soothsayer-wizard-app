/*
 * THE date format of the whole app — one source for every date a user reads
 * (user decision 2026-10-12: "the format of a date must be the same in the
 * whole system"; the Dashboard's format was chosen as the standard).
 *
 *   date alone                         2025/03/14            `formatDate`
 *   where space is tight               2025/03               `formatYearMonth`
 *   a data row's time                  2025/03/14 21:25:00   `formatDateTime` / `formatRowTime`
 *   a period bound the user typed,
 *   an instant the app recorded        2025/03/14 21:25      `formatDateTimeMinutes`
 *   a chart's time-axis tick           2025/03/14            `formatAxisTick`
 *                                      (+ " 06:00" when the tick is not a midnight)
 *
 * Always numerals, zero-padded, 24-hour clock — never a month name, and never
 * the PC's locale (`toLocaleDateString()` gives the ambiguous MM/DD/YYYY order
 * under en-US). Nothing else in `src/` may build a date string by hand.
 */

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

/** YYYY/MM/DD HH:mm, 24-hour clock, no seconds — a period bound the user typed
 *  (the date fields have minute resolution) or an instant the app recorded
 *  ("Trained …", "Files saved …", a project's last-opened time). */
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

/**
 * The wall clock WRITTEN in a timestamp text — a CSV row's time as Rust hands it
 * back. Read from the text's own digits and never passed through a `Date`, so an
 * explicit offset ("2026-02-09T23:50:00+07:00", "…Z") is ignored: the row reads
 * 23:50 on a PC in any time zone. A date with no time reads as 00:00:00. `null`
 * for text in any other shape.
 */
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

/**
 * A data row's time from its own text: `2025/03/14 21:25:00` (the row's OWN wall
 * clock — see `readWallClock`). `null` when the text is not in the usual
 * timestamp shape; the caller decides what to show then.
 */
export function formatRowTime(text: string, precision: DatePrecision = 'seconds'): string | null {
    const w = readWallClock(text);
    return w ? formatWallClock(w, precision) : null;
}

/**
 * The label of one tick of a chart's TIME axis (`value` = epoch ms, read in the
 * PC's time zone like the axis itself): the date alone when the tick is a
 * midnight — `2025/03/14` — and date + time when it is not — `2025/03/14 06:00`
 * (`…06:00:30` / `…06:00:30.250` when the tick is finer than a minute / a second).
 *
 * Why not the date alone on every tick: zoomed in to a day or less, several
 * ticks fall on the same day and would all read the same date. An axis puts its
 * ticks on round times, so with day-or-longer steps every tick is a midnight and
 * the axis shows plain dates; only finer steps add the time — and then at most
 * one tick per day is a midnight, so no two labels are ever the same.
 */
export function formatAxisTick(value: number): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const ms = d.getMilliseconds();
    if (ms !== 0) return `${formatDateTime(d)}.${String(ms).padStart(3, '0')}`;
    if (d.getSeconds() !== 0) return formatDateTime(d);
    if (d.getHours() !== 0 || d.getMinutes() !== 0) return formatDateTimeMinutes(d);
    return formatDate(d);
}
