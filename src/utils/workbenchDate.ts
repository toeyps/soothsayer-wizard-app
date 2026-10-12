/*
 * The Workbench's date helpers and the local-time parser every period helper
 * reads `datetime-local` text with.
 *
 * The FORMAT is not decided here: every function below prints through
 * `utils/dateFormat.ts`, the one date format of the whole app
 * (`2026/02/09`, `2026/02/09 23:50`, `2026/02/09 23:50:00` — never a month
 * name). What this file adds is which precision each kind of date gets and how
 * its text is read:
 *   - a period bound the user typed / an instant the app recorded → minutes
 *     (`formatBound`, `formatStamp`), read as LOCAL time;
 *   - a data row's time → seconds (`formatDataStamp`), read from the text's own
 *     wall clock, never shifted to another time zone.
 *
 * Lives in `utils/` so the pure helpers there (period reasons such as "P2 ends
 * before it starts — pick an end after 2026/05/11 00:00") print dates the same
 * way without importing from a component folder. `periodDisplay.ts` re-exports
 * `parseLocal`, `formatStamp` and `formatDataStamp`, so components keep
 * importing them from there.
 */

import { formatClock, formatDate, formatDateTime, formatDateTimeMinutes, formatRowTime } from './dateFormat';

/** Epoch ms of a `datetime-local` / ISO-ish string as LOCAL time; null if
 *  blank or unparseable. Date-only strings are read as local midnight. */
export function parseLocal(s: string | null | undefined): number | null {
    const t = (s ?? '').trim();
    if (!t) return null;
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t.replace(' ', 'T');
    const ms = new Date(norm).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** "23:50" (local, 24 h). */
export function clockText(ms: number): string {
    return formatClock(new Date(ms));
}

/**
 * "2026/02/09" (local) — a date alone. A date always carries its year:
 * `_withYear` no longer changes the text (it used to drop the year, "9 Feb");
 * it is still accepted so no caller has to change.
 */
export function dateText(ms: number, _withYear?: boolean): string {
    return formatDate(new Date(ms));
}

/**
 * An instant the APP recorded ("Trained …", "Files saved …"), in local time:
 * "2026/02/09 23:50" (24 h, no seconds). Takes an ISO timestamp string or epoch
 * ms; text that is not a date is returned as it is. Show it in mono (`.wbx-dt`).
 */
export function formatStamp(v: string | number | null | undefined): string {
    const ms = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : parseLocal(v);
    if (ms === null) return typeof v === 'string' ? v : '—';
    return formatDateTimeMinutes(new Date(ms));
}

/**
 * A period BOUND, for sentences: always date + time, "2026/05/11 06:00" — a
 * bound on its whole-day edge too ("2026/05/11 00:00", "2026/05/11 23:59").
 * Text that is not a date is returned as typed; blank gives ''. `_side` no
 * longer changes the text (it used to drop the time on a whole-day edge); it is
 * still accepted so no caller has to change.
 */
export function formatBound(raw: string | null | undefined, _side?: 'start' | 'end'): string {
    const ms = parseLocal(raw);
    if (ms === null) return (raw ?? '').trim();
    return formatDateTimeMinutes(new Date(ms));
}

/**
 * A timestamp that is DATA (a CSV row's time, as Rust hands it back: a chart
 * tooltip, the hover read-out, the lowest-score time, a scoring period's
 * lowest): "2026/02/09 23:50:00" — always with seconds, so neighbouring points
 * of sub-minute data never read as the same time.
 *
 * Formatted from the text's OWN wall-clock parts — it is never passed through a
 * `Date`, so an explicit offset ("2026-02-09T23:50:00+07:00", "…Z") still reads
 * "2026/02/09 23:50:00" on a PC in any time zone. `formatStamp` stays for
 * instants the APP recorded in UTC ("Trained …", "Files saved …"), which must
 * show in local time.
 *
 * `seconds: false` gives minutes ("2026/02/09 23:50"); `dateOnly: true` the date
 * alone ("2026/02/09"). Text in another shape is read as local time (which also
 * shows its own clock); text that is not a date is returned as it is.
 */
export function formatDataStamp(text: string | null | undefined, opts: { seconds?: boolean; dateOnly?: boolean } = {}): string {
    if (text == null) return '—';
    const t = text.trim();
    if (!t) return text;
    const precision = opts.dateOnly ? 'date' : opts.seconds === false ? 'minutes' : 'seconds';
    const own = formatRowTime(t, precision);
    if (own !== null) return own;
    const ms = parseLocal(t);
    if (ms === null) return t;
    const d = new Date(ms);
    return precision === 'date' ? formatDate(d) : precision === 'minutes' ? formatDateTimeMinutes(d) : formatDateTime(d);
}
