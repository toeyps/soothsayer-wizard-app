import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import ColourPicker from '../sensor/ColourPicker';
import type { Cluster } from './PairPlotCell';
import { rgbaToHex } from './pairPlotColors';
import { CLUSTER_NAME_MAX, cleanClusterName } from './pairPlotClusters';

/** Pair Plot cluster legend: chip row (swatch, renamable name, x per cluster); 'Clear' at 2+ clusters. Renders nothing until the first lasso. Memoised because the Pair Plot re-renders on every hover. */

/** Chip name: click, or Enter/Space/F2, to rename in place. Enter or blur saves, Esc cancels, an empty name keeps the old one. Duplicates allowed; Enter/Esc returns focus to the name. */
function ChipName({ label, onRename, onDraftChange }: {
    label: string;
    onRename: (name: string) => void;
    /** Called while the field is typed in (its width changes), for the overflow fade. */
    onDraftChange?: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(label);
    const inputRef = useRef<HTMLInputElement>(null);
    const nameRef = useRef<HTMLSpanElement>(null);
    /** Set once Enter/Esc handled the edit, so the blur from unmounting the input doesn't save again. */
    const doneRef = useRef(false);
    const refocusRef = useRef(false);

    useLayoutEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        } else if (refocusRef.current) {
            refocusRef.current = false;
            nameRef.current?.focus();
        }
    }, [editing]);

    // The field grows with its text → the chip row's overflow can change while typing.
    useEffect(() => { if (editing) onDraftChange?.(); }, [draft, editing, onDraftChange]);

    const start = () => {
        doneRef.current = false;
        setDraft(label);
        setEditing(true);
    };
    const finish = (save: boolean, refocus: boolean) => {
        if (doneRef.current) return;
        doneRef.current = true;
        const name = cleanClusterName(draft);
        if (save && name !== null && name !== label) onRename(name);
        refocusRef.current = refocus;
        setEditing(false);
    };

    if (editing) {
        return (
            <span className="pp-chip-edit" data-value={draft || ' '}>
                <input
                    ref={inputRef}
                    className="pp-chip-input"
                    value={draft}
                    maxLength={CLUSTER_NAME_MAX}
                    aria-label={`Rename ${label}`}
                    spellCheck={false}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                        // Keep Enter/Esc from reaching anything that listens above (a dialog's Esc).
                        e.stopPropagation();
                        if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
                        else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
                    }}
                    onBlur={() => finish(true, false)}
                />
            </span>
        );
    }
    return (
        <span
            ref={nameRef}
            className="pp-chip-name"
            role="button"
            tabIndex={0}
            title={`${label} — click to rename`}
            aria-label={`${label}, rename`}
            onClick={start}
            onKeyDown={e => {
                // role="button": Space activates it too (preventDefault so the strip doesn't scroll).
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') { e.preventDefault(); start(); }
            }}
        >
            {label}
        </span>
    );
}

export interface ClusterLegendProps {
    clusters: Cluster[];
    onRecolour: (id: string, hex: string) => void;
    onRename: (id: string, name: string) => void;
    onRemove: (id: string) => void;
    onClear: () => void;
    /** Where focus goes when nothing is left to focus (after Clear or x on the last chip): the toolbox, never <body>. */
    focusFallback?: () => void;
    className?: string;
}

function ClusterLegend({ clusters, onRecolour, onRename, onRemove, onClear, focusFallback, className = '' }: ClusterLegendProps) {
    const listRef = useRef<HTMLUListElement>(null);
    const [overflow, setOverflow] = useState(false);
    const hasClusters = clusters.length > 0;

    const check = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        setOverflow(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
    }, []);

    // Many clusters in a narrow window: the row scrolls sideways and a right-edge fade shows there is more.
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
        ro?.observe(el);
        el.addEventListener('scroll', check);
        return () => { ro?.disconnect(); el.removeEventListener('scroll', check); };
    }, [hasClusters, check]);
    // A new, removed or renamed chip changes the content width.
    useEffect(check, [clusters, check]);

    /** x focuses the next chip, else the previous, else the fallback, then removes (the footer legend unmounts with its last cluster). */
    const removeAt = (i: number) => {
        const items = listRef.current?.children;
        const target = items?.[i + 1] ?? items?.[i - 1];
        const el = target?.querySelector<HTMLElement>('.pp-chip-name')
            ?? target?.querySelector<HTMLElement>('.pp-chip-input')
            ?? target?.querySelector<HTMLElement>('button');
        if (el) el.focus();
        else focusFallback?.();
        onRemove(clusters[i].id);
    };
    const clearAll = () => {
        focusFallback?.();
        onClear();
    };

    if (!hasClusters) return null;
    const hexes = clusters.map(c => rgbaToHex(c.color));
    return (
        <div className={`pp-legend${className ? ` ${className}` : ''}`}>
            <ul
                ref={listRef}
                className={`pp-legend-chips${overflow ? ' is-overflow' : ''}`}
                aria-label="Clusters"
                onWheel={e => { if (listRef.current && e.deltaY) listRef.current.scrollLeft += e.deltaY; }}
            >
                {clusters.map((c, i) => (
                    <li key={c.id} className="pp-chip">
                        <ColourPicker
                            color={hexes[i]}
                            onChange={hex => onRecolour(c.id, hex)}
                            used={hexes.filter((_, k) => k !== i)}
                            label={c.label}
                            title="Cluster colour"
                        />
                        <ChipName label={c.label} onRename={name => onRename(c.id, name)} onDraftChange={check} />
                        <button
                            type="button"
                            className="pp-chip-x"
                            onClick={() => removeAt(i)}
                            title={`Remove ${c.label}`}
                            aria-label={`Remove ${c.label}`}
                        >
                            <X size={11} strokeWidth={2.25} />
                        </button>
                    </li>
                ))}
            </ul>
            {clusters.length > 1 && (
                <button type="button" className="pp-legend-clear" onClick={clearAll} title="Remove every cluster" aria-label="Clear all clusters">
                    Clear
                </button>
            )}
        </div>
    );
}

export default memo(ClusterLegend);
