import { useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import TaggedPointList, { type TaggedPointListItem } from './TaggedPointList';
import { SensorInline } from '../sensor/SensorLabel';
import { MAX_TAGGED_POINTS } from './pairPlotColors';
import type { SensorInfo } from '../sensor/sensorInfo';

export interface TagCompareRow {
    key: string;
    info: SensorInfo;
    /** The sensor's line colour (Line chart). */
    color?: string;
    /** A short lead before the name — the axis ("X" / "Y") on the Scatter chart. */
    lead?: string;
    /** One ready-to-print NUMBER per tag, in the order of `items` ("—" when there is none).
     *  The unit is not in it: it is printed once per row, beside the sensor's name. */
    cells: string[];
}

interface TagCompareTableProps {
    /** One column per tagged point, in badge order. */
    items: TaggedPointListItem[];
    /** One row per sensor. */
    rows: TagCompareRow[];
    onRemove: (id: string) => void;
    /** Where keyboard focus goes when the last tag is removed (the table unmounts). */
    emptyFocusRef?: RefObject<HTMLElement | null>;
    /** `panel` = fills the Dashboard's "Tagged points" tab (no height cap, no fold button);
     *  `docked` (default) = a strip under the chart. */
    variant?: 'docked' | 'panel';
}

/**
 * The values of every tagged point, side by side: one column per tag (a rule and
 * a dot in its colour, the date over the time, its own ×), one row per sensor with
 * its unit printed once. Line and Scatter. Layout: SPEC
 * docs/design/handoff/dashboard-tagged-points/README.md (2026-10-12).
 *
 * The values used to be drawn ON the chart, one box per tag at the tagged
 * point. With five sensors a box is about 330 px wide, so two tags closer than
 * that covered each other (and the lines) and neither could be read. On the
 * chart a tag is now only a dot in its colour; the numbers live here, where
 * any count of tags and sensors fits — the columns scroll sideways, the rows
 * scroll down — and two tags can be compared along one row.
 *
 * Where it shows: in the Dashboard it is rendered into the "Tagged points" tab
 * of the panel under the chart (`TagTableSlot` with a host element), so the
 * chart keeps its full height; with no host it docks under the chart itself.
 *
 * The column heads ARE `TaggedPointList` (a list of tags with one × each, and
 * its focus rule when a tag is removed), laid out as cells of the same grid.
 */
export default function TagCompareTable({ items, rows, onRemove, emptyFocusRef, variant = 'docked' }: TagCompareTableProps) {
    const [folded, setFolded] = useState(false);
    if (items.length === 0) return null;
    const panel = variant === 'panel';
    const open = panel || !folded;

    return (
        <section className={`tag-table${panel ? ' tag-table--panel' : ''}`} data-testid="tag-table" aria-label="Values at the tagged points">
            <div
                className="tag-table-grid"
                // The names stay next to their values (capped columns), and a last, empty column
                // takes the rest of the width, so the head band and the row lines cross the whole
                // tab instead of the table floating in a corner. Many tags: the columns shrink to
                // 124 px, then the table scrolls sideways under the fixed name column.
                style={{ gridTemplateColumns: `minmax(220px, 400px) repeat(${items.length}, minmax(124px, 152px)) minmax(0, 1fr)` }}
            >
                <div className="tag-table-corner">
                    {panel ? (
                        <span className="tag-table-title">Sensor</span>
                    ) : (
                        <button
                            type="button"
                            className="tag-table-toggle"
                            aria-expanded={open}
                            onClick={() => setFolded(f => !f)}
                            title={open ? 'Hide the values' : 'Show the values'}
                        >
                            {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                            Tagged points
                            <span className="tag-table-count">{items.length}</span>
                        </button>
                    )}
                </div>
                <TaggedPointList items={items} onRemove={onRemove} emptyFocusRef={emptyFocusRef} />
                <div className="tag-table-fill tag-table-fill--head" aria-hidden="true" />
                {open && rows.map(row => (
                    // One element per row (`display: contents`), so hovering any cell lights the whole row.
                    <div key={row.key} className="tag-table-row">
                        <div className="tag-table-name" data-testid="tag-table-name">
                            {row.color && <i className="tag-table-swatch" style={{ background: row.color }} aria-hidden="true" />}
                            {row.lead && <span className="tag-table-lead">{row.lead}</span>}
                            <SensorInline tag={row.info.tag} info={row.info} size="sm" fit />
                            {/* The unit, ONCE per row (it used to be repeated in every cell). */}
                            {row.info.unit && <span className="tag-table-unit" data-testid="tag-table-unit">{row.info.unit}</span>}
                        </div>
                        {items.map((item, c) => {
                            const text = row.cells[c] ?? '—';
                            return (
                                <div
                                    key={item.id}
                                    className={`tag-table-val${text === '—' ? ' tag-table-val--none' : ''}`}
                                    data-testid="tag-table-val"
                                    title={`${row.info.description || row.info.tag} · ${item.label}${text === '—' ? ' · no value at this point' : row.info.unit ? ` · ${text} ${row.info.unit}` : ''}`}
                                >
                                    {text}
                                </div>
                            );
                        })}
                        <div className="tag-table-fill" aria-hidden="true" />
                    </div>
                ))}
            </div>
            {/* How many of the chart's tags are used — and, at the limit, why a click adds nothing. */}
            {panel && (
                <p className="tag-table-foot" data-testid="tag-table-foot">
                    <b>{items.length}</b> of {MAX_TAGGED_POINTS} points
                    {items.length >= MAX_TAGGED_POINTS && <span className="tag-table-foot-full"> · the chart holds {MAX_TAGGED_POINTS} at most — remove one to tag another</span>}
                </p>
            )}
        </section>
    );
}

/**
 * Where a chart puts its tag table. `host` undefined = nobody offers a place: dock it under the
 * chart. `host` null = the Dashboard's "Tagged points" tab is not open right now: draw nothing.
 * Otherwise it is rendered INTO that tab.
 */
export function TagTableSlot({ host, ...props }: TagCompareTableProps & { host?: HTMLElement | null }) {
    if (host === undefined) return <TagCompareTable {...props} />;
    if (!host) return null;
    return createPortal(<TagCompareTable {...props} variant="panel" />, host);
}

/** A value cell: the number as the tooltips print it; "—" when there is none. The unit is NOT
 *  part of the cell — the table prints it once per row, beside the sensor's name. */
export function tagCell(text: string | null): string {
    return text == null ? '—' : text;
}
