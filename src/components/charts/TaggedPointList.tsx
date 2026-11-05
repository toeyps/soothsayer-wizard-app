import { Fragment, useRef, type CSSProperties, type RefObject } from 'react';
import { X } from 'lucide-react';

export interface TaggedPointListItem {
    id: string;
    /** Position number, used only for assistive tech (the × button's label); a tag is told apart by colour. */
    badge: string;
    color: string;
    /** Short human label, normally the point's timestamp. */
    label: string;
}

interface TaggedPointListProps {
    items: TaggedPointListItem[];
    onRemove: (id: string) => void;
    /** Where focus goes when the last tag is removed: the chart toolbox's Tag button, always rendered. */
    emptyFocusRef?: RefObject<HTMLElement | null>;
}

/** Tag Point markers under the toolbox, one row per tag with its own ×; presentation only. Removing a row moves focus first (next row's ×, previous if last, else `emptyFocusRef`), or it drops to <body>. */
export default function TaggedPointList({ items, onRemove, emptyFocusRef }: TaggedPointListProps) {
    const removeButtons = useRef(new Map<string, HTMLButtonElement>());
    if (items.length === 0) return null;

    const handleRemove = (index: number) => {
        const neighbour = items[index + 1] ?? items[index - 1];
        const target = neighbour ? removeButtons.current.get(neighbour.id) : emptyFocusRef?.current;
        target?.focus();
        onRemove(items[index].id);
    };

    return (
        <ul className="chart-tag-list" aria-label="Tagged points">
            {items.map((item, index) => (
                <li key={item.id} className="chart-tag-item" style={{ '--tag-c': item.color } as CSSProperties}>
                    <span className="chart-tag-dot" style={{ background: item.color }} aria-hidden="true" />
                    {/* Date and time on two short lines to keep the column narrow; the space between keeps one stamp for copy and screen readers. */}
                    <span className="chart-tag-label" title={item.label}>
                        {splitStamp(item.label).map((part, i, all) => (
                            <Fragment key={i}>
                                {i > 0 && ' '}
                                <span className={all.length === 2 && i === 0 ? 'chart-tag-date' : 'chart-tag-time'}>{part}</span>
                            </Fragment>
                        ))}
                    </span>
                    <button
                        type="button"
                        className="chart-tag-remove"
                        ref={el => {
                            if (el) removeButtons.current.set(item.id, el);
                            else removeButtons.current.delete(item.id);
                        }}
                        onClick={() => handleRemove(index)}
                        aria-label={`Remove tag ${item.badge} ${item.label}`}
                        title="Remove this tag"
                    >
                        <X size={11} />
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** "YYYY/MM/DD HH:mm:ss" → [date, time]; anything else stays whole. Display only. */
export function splitStamp(label: string): string[] {
    const m = /^(\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/.exec(label);
    return m ? [m[1], m[2]] : [label];
}

/** Tags oldest first, matching the table's columns and the Line chart's left-to-right order. Unreadable times keep tagging order, after dated ones; `timeOf` returns epoch ms (NaN = none). */
export function sortTagsByTime<T>(tags: readonly T[], timeOf: (tag: T) => number): T[] {
    return tags
        .map((tag, i) => ({ tag, i, ms: timeOf(tag) }))
        .sort((a, b) => {
            const at = Number.isFinite(a.ms);
            const bt = Number.isFinite(b.ms);
            if (at && bt) return a.ms - b.ms || a.i - b.i;
            if (at !== bt) return at ? -1 : 1;
            return a.i - b.i;
        })
        .map(e => e.tag);
}

/** First palette index no remaining tag uses (tags.length could reuse a colour after a middle tag is removed). */
export function firstFreeColorIndex(usedIndices: number[], paletteSize: number): number {
    const used = new Set(usedIndices);
    for (let i = 0; i < paletteSize; i++) {
        if (!used.has(i)) return i;
    }
    // Defensive only: callers cap tags at MAX_TAGGED_POINTS, which equals
    // RANGE_PALETTE.length, so a free slot always exists above.
    return usedIndices.length % paletteSize;
}
