import { useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import TaggedPointList, { type TaggedPointListItem } from './TaggedPointList';
import { SensorInline, SensorSetProvider, SetPrefixLine } from '../sensor/SensorLabel';
import { MAX_TAGGED_POINTS } from './pairPlotColors';
import { displayedName } from '../../utils/sensorNames';
import type { SensorInfo } from '../sensor/sensorInfo';

export interface TagCompareRow {
    key: string;
    info: SensorInfo;
    /** The sensor's line colour (Line chart). */
    color?: string;
    /** A short lead before the name — the axis ("X" / "Y") on the Scatter chart. */
    lead?: string;
    /** One ready-to-print number per tag, in `items` order ('—' if none); the unit is printed once per row. */
    cells: string[];
}

interface TagCompareTableProps {
    /** One column per tagged point, in TIME order (the charts sort them: `sortTagsByTime`). */
    items: TaggedPointListItem[];
    /** One row per sensor. */
    rows: TagCompareRow[];
    onRemove: (id: string) => void;
    /** Where keyboard focus goes when the last tag is removed (the table unmounts). */
    emptyFocusRef?: RefObject<HTMLElement | null>;
    /** `panel` fills the Dashboard's Tagged points tab; `docked` (default) is a strip under the chart. */
    variant?: 'docked' | 'panel';
}

/** Tagged points side by side: one column per tag, one row per sensor with its unit once. */
export default function TagCompareTable({ items, rows, onRemove, emptyFocusRef, variant = 'docked' }: TagCompareTableProps) {
    const [folded, setFolded] = useState(false);
    const setNames = useMemo(() => rows.map(r => displayedName(r.info)), [rows]);
    if (items.length === 0) return null;
    const panel = variant === 'panel';
    const open = panel || !folded;

    return (
        // The rows are one set: while a name is cut, the shared start prints once in the corner and rows print the rest.
        <SensorSetProvider names={setNames} drop>
        <section className={`tag-table${panel ? ' tag-table--panel' : ''}`} data-testid="tag-table" aria-label="Values at the tagged points">
            <div
                className="tag-table-grid"
                // Capped columns plus a last 1fr one so the head band and row lines span the tab; many tags shrink to 124 px, then scroll.
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
                    {open && <SetPrefixLine className="tag-table-prefix" testid="tag-table-prefix" />}
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
                            {/* The unit prints once per row, not in every cell. */}
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
        </SensorSetProvider>
    );
}

/** `host` undefined: dock under the chart. `host` null: Tagged points tab closed, draw nothing. Otherwise render into it. */
export function TagTableSlot({ host, ...props }: TagCompareTableProps & { host?: HTMLElement | null }) {
    if (host === undefined) return <TagCompareTable {...props} />;
    if (!host) return null;
    return createPortal(<TagCompareTable {...props} variant="panel" />, host);
}

/** The number as tooltips print it, '—' if none; the unit isn't part of the cell. */
export function tagCell(text: string | null): string {
    return text == null ? '—' : text;
}
