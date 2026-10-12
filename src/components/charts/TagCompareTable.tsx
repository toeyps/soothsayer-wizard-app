import { Fragment, useState, type RefObject } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import TaggedPointList, { type TaggedPointListItem } from './TaggedPointList';
import { SensorInline } from '../sensor/SensorLabel';
import type { SensorInfo } from '../sensor/sensorInfo';

export interface TagCompareRow {
    key: string;
    info: SensorInfo;
    /** The sensor's line colour (Line chart). */
    color?: string;
    /** A short lead before the name — the axis ("X" / "Y") on the Scatter chart. */
    lead?: string;
    /** One ready-to-print value (with its unit) per tag, in the order of `items`. */
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
}

/**
 * The values of every tagged point, side by side, docked UNDER the chart
 * (Line and Scatter): one column per tag (badge + time + its own ×), one row
 * per sensor.
 *
 * The values used to be drawn ON the chart, one box per tag at the tagged
 * point. With five sensors a box is about 330 px wide, so two tags closer than
 * that covered each other (and the lines) and neither could be read. On the
 * chart a tag is now only its numbered marker; the numbers live here, where
 * any count of tags and sensors fits — the columns scroll sideways, the rows
 * scroll down — and two tags can be compared along one row.
 *
 * The column heads ARE `TaggedPointList` (a list of tags with one × each, and
 * its focus rule when a tag is removed), laid out as cells of the same grid.
 */
export default function TagCompareTable({ items, rows, onRemove, emptyFocusRef }: TagCompareTableProps) {
    const [open, setOpen] = useState(true);
    if (items.length === 0) return null;

    return (
        <section className="tag-table" data-testid="tag-table" aria-label="Values at the tagged points">
            <div
                className="tag-table-grid"
                // Kept together on the left: the names next to their values, not stretched across a wide window.
                style={{ gridTemplateColumns: `minmax(220px, 380px) repeat(${items.length}, minmax(168px, 210px))` }}
            >
                <div className="tag-table-corner">
                    <button
                        type="button"
                        className="tag-table-toggle"
                        aria-expanded={open}
                        onClick={() => setOpen(o => !o)}
                        title={open ? 'Hide the values' : 'Show the values'}
                    >
                        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                        Tagged points
                        <span className="tag-table-count">{items.length}</span>
                    </button>
                </div>
                <TaggedPointList items={items} onRemove={onRemove} emptyFocusRef={emptyFocusRef} />
                {open && rows.map(row => (
                    <Fragment key={row.key}>
                        <div className="tag-table-name" data-testid="tag-table-name">
                            {row.color && <i className="tag-table-swatch" style={{ background: row.color }} aria-hidden="true" />}
                            {row.lead && <span className="tag-table-lead">{row.lead}</span>}
                            <SensorInline tag={row.info.tag} info={row.info} size="sm" fit />
                        </div>
                        {items.map((item, c) => (
                            <div
                                key={item.id}
                                className="tag-table-val"
                                data-testid="tag-table-val"
                                title={`${row.info.description || row.info.tag} · ${item.badge} ${item.label}`}
                            >
                                {row.cells[c] ?? '—'}
                            </div>
                        ))}
                    </Fragment>
                ))}
            </div>
        </section>
    );
}

/** A value cell: the number as the tooltips print it, then the unit; "—" when there is none. */
export function tagCell(text: string | null, unit?: string): string {
    if (text == null) return '—';
    return unit ? `${text} ${unit}` : text;
}
