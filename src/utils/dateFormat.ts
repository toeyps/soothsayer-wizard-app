const pad2 = (n: number): string => String(n).padStart(2, '0');

/** YYYY/MM/DD — the system-wide date format. Locale-independent (unlike
 *  `toLocaleDateString()`, which defaults to the ambiguous MM/DD/YYYY order
 *  under en-US). */
export function formatDate(d: Date): string {
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** YYYY/MM/DD HH:mm:ss, 24-hour clock. */
export function formatDateTime(d: Date): string {
    return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** YYYY/MM — compact month+year, for cramped axis ticks. */
export function formatYearMonth(d: Date): string {
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}`;
}
