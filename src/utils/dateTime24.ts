/** App date fields as text `YYYY/MM/DD HH:mm`, always 24-hour (a native `datetime-local` follows the Windows region, AM/PM). Held values stay `YYYY-MM-DDTHH:mm` (seconds if present). */

const pad = (n: number) => String(n).padStart(2, '0');

/** The text a stored value shows as. */
export function formatDateTime24(value: string | null | undefined): string {
    return (value ?? '').trim().replace('T', ' ').replace(/^(\d+)-(\d+)-(\d+)/, '$1/$2/$3');
}

/** Value of typed text, or `''` unless a complete real date and time; `/` or `-` in the date, space or `T` before the time. */
export function parseDateTime24(text: string): string {
    const m = /^(\d{4,6})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
    if (!m) return '';
    const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
    const second = m[6] === undefined ? null : Number(m[6]);
    if (hour > 23 || minute > 59 || (second ?? 0) > 59) return '';
    const d = new Date(2000, month - 1, day);
    d.setFullYear(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return '';
    const date = `${m[1]}-${pad(month)}-${pad(day)}`;
    return `${date}T${pad(hour)}:${pad(minute)}${second === null ? '' : `:${pad(second)}`}`;
}

/** The value inside `min` / `max` (same format, so they compare as text). */
export function clampDateTime(value: string, min?: string, max?: string): string {
    if (min && value < min) return min;
    if (max && value > max) return max;
    return value;
}

/** `YYYY-MM-DD` of each cell of a month's calendar: six weeks, Sunday first, with the days around the month. */
export function monthCells(year: number, month: number): string[] {
    const first = new Date(year, month, 1);
    const cells: string[] = [];
    for (let i = 0; i < 42; i++) {
        const d = new Date(year, month, 1 - first.getDay() + i);
        cells.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    return cells;
}
