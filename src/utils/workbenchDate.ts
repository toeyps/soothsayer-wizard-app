/*
 * THE Workbench date-and-time format — "9 Feb 2026 23:50" (24 h, no seconds;
 * SPEC workbench-redesign §1 "One date format") — and the local-time parser
 * every period helper reads `datetime-local` text with.
 *
 * Moved here from `src/components/windows/periodDisplay.ts` (2026-10-10,
 * workbench redesign phase C) so the pure helpers in `utils/` (period reasons
 * such as "P2 ends before it starts — pick an end after 11 May 2026") print
 * dates in the same one format without importing from a component folder.
 * `periodDisplay.ts` re-exports `parseLocal`, `formatStamp` and
 * `formatDataStamp`, so components keep importing them from there.
 */

export const MONTHS_SHORT: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

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
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "9 Feb" / "9 Feb 2026" (local). */
export function dateText(ms: number, withYear: boolean): string {
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

/**
 * THE Workbench date-and-time format: "9 Feb 2026 23:50" (24 h, no seconds,
 * local time). Takes a CSV / ISO timestamp string or epoch ms; text that is
 * not a date is returned as it is. Show it in mono (`.wbx-dt`).
 */
export function formatStamp(v: string | number | null | undefined): string {
    const ms = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : parseLocal(v);
    if (ms === null) return typeof v === 'string' ? v : '—';
    return `${dateText(ms, true)} ${clockText(ms)}`;
}

/**
 * A period BOUND in the Workbench format, for sentences: the date alone when
 * the bound sits on its whole-day edge (a start at 00:00, an end at 23:59) —
 * "11 May 2026" — and date + time otherwise ("11 May 2026 06:00"). Text that
 * is not a date is returned as typed; blank gives ''.
 */
export function formatBound(raw: string | null | undefined, side: 'start' | 'end'): string {
    const ms = parseLocal(raw);
    if (ms === null) return (raw ?? '').trim();
    const clock = clockText(ms);
    return clock === (side === 'start' ? '00:00' : '23:59') ? dateText(ms, true) : `${dateText(ms, true)} ${clock}`;
}

/** `YYYY-MM-DD[ T]HH:MM[:SS[.fff]]` with an optional `Z` / `+07:00` offset. */
const DATA_STAMP_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * `formatStamp` for a timestamp that is DATA (a CSV row's time, as Rust hands it
 * back: the lowest-score time, the hover read-out, a scoring period's lowest).
 * Formatted from the text's OWN wall-clock parts — it is never passed through a
 * `Date`, so an explicit offset ("2026-02-09T23:50:00+07:00") reads "9 Feb 2026
 * 23:50" on a PC in any time zone (review of 452d5c2, item 6b). `formatStamp`
 * stays for instants the APP recorded in UTC ("Trained …", "Files saved …"), which
 * must show in local time.
 *
 * `seconds: true` (hover read-outs) adds ":SS" when the stamp's seconds are not
 * zero, so neighbouring points of sub-minute data do not read as the same time.
 * Text in another shape goes through `formatStamp` (read as local time, which
 * also shows its own clock); text that is not a date is returned as it is.
 */
export function formatDataStamp(text: string | null | undefined, opts: { seconds?: boolean } = {}): string {
    if (text == null) return '—';
    const t = text.trim();
    if (!t) return text;
    const m = DATA_STAMP_RE.exec(t);
    const month = m ? Number(m[2]) : 0;
    if (!m || month < 1 || month > 12) {
        const ms = parseLocal(t);
        if (ms === null) return t;
        const sec = new Date(ms).getSeconds();
        return `${dateText(ms, true)} ${clockText(ms)}${opts.seconds && sec !== 0 ? `:${pad(sec)}` : ''}`;
    }
    const sec = Number(m[6] ?? 0);
    return `${Number(m[3])} ${MONTHS_SHORT[month - 1]} ${m[1]} ${pad(Number(m[4] ?? 0))}:${m[5] ?? '00'}${opts.seconds && sec !== 0 ? `:${pad(sec)}` : ''}`;
}
