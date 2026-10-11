import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import ColourPicker from '../sensor/ColourPicker';
import type { Cluster } from './PairPlotCell';
import { rgbaToHex } from './pairPlotColors';
import { CLUSTER_NAME_MAX, cleanClusterName } from './pairPlotClusters';

/**
 * Pair Plot cluster legend.
 * A chip row in the strip above the matrix (and in the enlarged view's footer):
 * per cluster the shared ColourPicker swatch + the name (renamable in place) +
 * a small × to remove that one cluster. "Clear" removes every cluster and only
 * shows at 2+ (with one, the × already does it). Renders nothing until the
 * first lasso. Memoised: the Pair Plot re-renders on every hover move, the
 * legend only when its clusters change.
 */

/** The chip's name. Click it, or focus it and press Enter/Space/F2, to rename: it
 *  becomes a text field sized to its text, with the text selected. Enter or
 *  leaving the field saves; Esc cancels; an empty name keeps the old one.
 *  After Enter/Esc focus returns to the name (after a click elsewhere it stays
 *  where the user clicked). Duplicate names are allowed. */
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
    /** Set once Enter/Esc has handled the edit, so the blur that follows the
     *  input unmounting cannot save a second time (or save a cancelled edit). */
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
    /** Where focus goes when the legend has nothing left to focus (after Clear, or
     *  after × on the last chip) — the toolbox, so focus never falls to <body>. */
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

    // Many clusters in a narrow window: the row scrolls sideways (the mouse
    // wheel works too) and a fade on the right edge says there is more.
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

    /** × → focus the next chip's name, else the previous chip's, else the
     *  fallback. Focused BEFORE removing, while every target still exists (the
     *  footer legend unmounts with its last cluster). */
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
