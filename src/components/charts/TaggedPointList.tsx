import { Fragment, useRef, type CSSProperties, type RefObject } from 'react';
import { X } from 'lucide-react';

export interface TaggedPointListItem {
    id: string;
    /** Position number (①②…). Not drawn (a tag is told apart by its COLOUR, on the chart and
     *  here — user decision 2026-10-12: the digit inside a small dot could not be read); it only
     *  names the tag for assistive tech, in the × button's label. */
    badge: string;
    color: string;
    /** Short human label, normally the point's timestamp. */
    label: string;
}

interface TaggedPointListProps {
    items: TaggedPointListItem[];
    onRemove: (id: string) => void;
    /** Where keyboard focus goes when the LAST tag is removed (the list
     *  unmounts, so its own buttons can't hold it) — the chart toolbox's Tag
     *  button in both charts, which is always rendered. */
    emptyFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The list of pinned Tag Point markers shown under the chart's toolbox,
 * one row per tag with its own × button — so ONE tag can be removed without
 * clearing them all; "Clear all" (the trash button in the toolbox) removes
 * every tag.
 *
 * Shared by LineChart and ScatterChart, which each own their tag state
 * (Line's is lifted to Dashboard, Scatter's stays local) — this component is
 * presentation only. The × buttons are native buttons, so they are reachable
 * with Tab and fire on Enter/Space; their accessible name says which tag
 * they remove. Works with tag mode on or off.
 *
 * Focus: removing a row would unmount the focused × and drop keyboard focus
 * to <body>, so focus moves FIRST — to the next row's × (the previous row's
 * if it was the last row), or to `emptyFocusRef` when no tag remains — and
 * only then is the tag removed. Rows are keyed by id, so the newly focused
 * button survives the re-render.
 */
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
                    {/* "2026/06/21 03:10:00" reads as two short lines — the date, then the time —
                        so a column can be narrow and the time is not squeezed against the ×.
                        A label that is not a date and time ("Point 3") stays one line. The space
                        between the two keeps the text one readable stamp for copy and assistive tech. */}
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

/** Colour slot for a NEW tag: the first palette index no remaining tag is
 *  using. Picking `tags.length` instead (the old rule) re-used a colour that
 *  was still on the chart as soon as any tag other than the last had been
 *  removed — e.g. tags ①②③, remove ②, add one → two tags in ③'s colour. */
export function firstFreeColorIndex(usedIndices: number[], paletteSize: number): number {
    const used = new Set(usedIndices);
    for (let i = 0; i < paletteSize; i++) {
        if (!used.has(i)) return i;
    }
    // Defensive only: callers cap tags at MAX_TAGGED_POINTS, which equals
    // RANGE_PALETTE.length, so a free slot always exists above.
    return usedIndices.length % paletteSize;
}
