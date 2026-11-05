/* Workbench date helpers and the local-time parser for `datetime-local` text. Printing goes through `utils/dateFormat.ts`; this file picks precision: period bounds and app-recorded instants to minutes (local time), data row times to seconds (from the text's own wall clock, never shifted). `periodDisplay.ts` re-exports `parseLocal`, `formatStamp`, `formatDataStamp`. */

import { formatDate, formatDateTime, formatDateTimeMinutes, formatRowTime } from './dateFormat';

/** Epoch ms of a `datetime-local`/ISO-ish string as local time; null if blank or unparseable. Date-only reads as local midnight. */
export function parseLocal(s: string | null | undefined): number | null {
    const t = (s ?? '').trim();
    if (!t) return null;
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t.replace(' ', 'T');
    const ms = new Date(norm).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** '2026/02/09' (local), a date alone. `_withYear` is ignored, kept so callers needn't change. */
export function dateText(ms: number, _withYear?: boolean): string {
    return formatDate(new Date(ms));
}

/** An app-recorded instant ('Trained …') as local '2026/02/09 23:50'. Takes an ISO string or epoch ms; non-dates come back as is. */
export function formatStamp(v: string | number | null | undefined): string {
    const ms = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : parseLocal(v);
    if (ms === null) return typeof v === 'string' ? v : '—';
    return formatDateTimeMinutes(new Date(ms));
}

/** A period bound for sentences: always date + time, '2026/05/11 06:00'. Non-dates come back as typed; blank gives ''. `_side` is ignored. */
export function formatBound(raw: string | null | undefined, _side?: 'start' | 'end'): string {
    const ms = parseLocal(raw);
    if (ms === null) return (raw ?? '').trim();
    return formatDateTimeMinutes(new Date(ms));
}

/** A data timestamp (CSV row time from Rust): '2026/02/09 23:50:00', with seconds so sub-minute neighbours differ. Built from the text's own wall-clock parts, never through a `Date`, so an explicit offset reads the same in any PC time zone. `seconds: false` gives minutes, `dateOnly: true` the date; other shapes read as local time. */
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
