import type { TimeHighlight } from '../types';

/** Only enabled highlights with parseable start/end are ever matched against
 *  — this is recomputed by every caller from the full `timeHighlights` list
 *  rather than memoized here, since the list is small (a handful of entries)
 *  and callers already have their own effect/memo boundaries. */
function parsedEnabled(highlights: TimeHighlight[]): Array<{ highlight: TimeHighlight; start: number; end: number }> {
    const out: Array<{ highlight: TimeHighlight; start: number; end: number }> = [];
    for (const h of highlights) {
        if (!h.enabled) continue;
        const start = new Date(h.start).getTime();
        const end = new Date(h.end).getTime();
        if (isNaN(start) || isNaN(end)) continue;
        out.push({ highlight: h, start: Math.min(start, end), end: Math.max(start, end) });
    }
    return out;
}

/** First enabled highlight (in list order) whose window contains `timestamp`
 *  — same "first match wins" rule already used for Scatter's criteria-range
 *  bands, so a point in two overlapping highlights doesn't need a tie-break
 *  rule beyond "whichever was added first". Returns null for an unparsable
 *  timestamp or no match. */
export function firstMatchingHighlight(timestamp: string | null | undefined, highlights: TimeHighlight[]): TimeHighlight | null {
    if (!timestamp) return null;
    const t = new Date(timestamp).getTime();
    if (isNaN(t)) return null;
    for (const { highlight, start, end } of parsedEnabled(highlights)) {
        if (t >= start && t <= end) return highlight;
    }
    return null;
}

/** Whether `timestamp` falls inside ANY enabled highlight window — cheaper
 *  than `firstMatchingHighlight` when the caller only needs a yes/no signal
 *  (e.g. PairPlotCell's size-based emphasis, which doesn't distinguish which
 *  highlight matched). */
export function isTimestampHighlighted(timestamp: string | null | undefined, highlights: TimeHighlight[]): boolean {
    return firstMatchingHighlight(timestamp, highlights) !== null;
}
