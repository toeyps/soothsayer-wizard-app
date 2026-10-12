/*
 * Evenly spaced ticks for a chart's TIME axis.
 *
 * ECharts places time ticks on the calendar: with a weekly step it marks the
 * 1st, 8th, 15th, 22nd and 29th of every month AND the 1st of the next one, so
 * the gap at each month end is 2–3 days (the 29th is then hidden as an
 * overlap) and the visible labels read 7, 7, 7, 9–10 days apart — an uneven
 * row. These ticks keep ONE fixed step across the whole axis instead, anchored
 * to a fixed day so they do not slide while the user pans.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Steps below a day, in ms. */
const SUB_DAY_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 8 * HOUR, 12 * HOUR];
/** Steps of whole days. */
const DAY_STEPS = [1, 2, 3, 5, 7, 10, 14, 21];
/** Steps of whole months (12 = a year, then several years). */
const MONTH_STEPS = [1, 2, 3, 6, 12, 24, 60, 120];

/** Average length of a month in ms — only to choose a step, never to place a tick. */
const MONTH_MS = 30.4375 * DAY;

/** Hard cap on the ticks one call returns (a runaway range never builds a huge array). */
export const MAX_TIME_TICKS = 2000;

export interface TimeTicks {
    /** Identifies the step ("d7", "h6", "m1" …): the same key = the same grid of ticks. */
    key: string;
    /** Tick positions (epoch ms, local-time aligned), ascending, inside [from, to]. */
    values: number[];
}

/** Local midnight of the day `ms` falls on. */
function dayStart(ms: number): Date {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
}

/** Days since a fixed local date — the anchor that keeps a day grid still while panning. */
function dayIndex(d: Date): number {
    return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(2000, 0, 1)) / DAY);
}

/**
 * Ticks one fixed step apart covering `[from, to]`, with at most about
 * `maxLabels` of them inside `[visibleFrom, visibleTo]` (the step is chosen for
 * the VISIBLE span; the ticks are generated for the wider range so a pan does
 * not need new ones). Day steps sit on local midnights, month steps on the 1st.
 */
export function evenTimeTicks(visibleFrom: number, visibleTo: number, maxLabels: number, from = visibleFrom, to = visibleTo): TimeTicks {
    const span = visibleTo - visibleFrom;
    if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return { key: 'none', values: [] };
    const want = Math.max(2, Math.floor(maxLabels));
    const fits = (stepMs: number) => span / stepMs <= want;

    const sub = SUB_DAY_STEPS.find(fits);
    if (sub !== undefined) {
        // Anchored to the local midnight of the first day, so 6 h ticks read 00:00, 06:00, 12:00 …
        const base = dayStart(from).getTime();
        const values: number[] = [];
        for (let t = base + Math.ceil((from - base) / sub) * sub; t <= to && values.length < MAX_TIME_TICKS; t += sub) values.push(t);
        return { key: `s${sub}`, values };
    }

    const days = DAY_STEPS.find(n => fits(n * DAY));
    if (days !== undefined) {
        const values: number[] = [];
        const d = dayStart(from);
        if (d.getTime() < from) d.setDate(d.getDate() + 1);
        // Move to the next day on the fixed grid, then step by calendar days (so every tick is a midnight).
        const off = ((dayIndex(d) % days) + days) % days;
        if (off !== 0) d.setDate(d.getDate() + (days - off));
        for (; d.getTime() <= to && values.length < MAX_TIME_TICKS; d.setDate(d.getDate() + days)) values.push(d.getTime());
        return { key: `d${days}`, values };
    }

    const months = MONTH_STEPS.find(n => fits(n * MONTH_MS)) ?? MONTH_STEPS[MONTH_STEPS.length - 1];
    const values: number[] = [];
    const first = new Date(from);
    const d = new Date(first.getFullYear(), first.getMonth(), 1);
    if (d.getTime() < from) d.setMonth(d.getMonth() + 1);
    const idx = () => d.getFullYear() * 12 + d.getMonth();
    while (idx() % months !== 0) d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= to && values.length < MAX_TIME_TICKS; d.setMonth(d.getMonth() + months)) values.push(d.getTime());
    return { key: `m${months}`, values };
}

/** Pixels one tick label needs (text + breathing room): a date alone, or date + time below a day. */
export function tickPitchPx(key: string, fontSize = 12): number {
    const chars = key.startsWith('s') ? 16 : 10; // "2025/03/14 06:00" vs "2025/03/14"
    return Math.round(chars * fontSize * 0.62 + 34);
}
