import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown, ChevronRight, Lock, Plus, Search, X } from 'lucide-react';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import Portal from '../Portal';
import { SensorInline } from './SensorLabel';
import { sensorHaystack, sensorTitle, useSensorLookup } from './sensorInfo';

/**
 * Customer item 3 (SPEC FINAL 2026-10-09 §1, DESIGN_SYSTEM §4 "Sensor picking — ONE picker").
 *  - `SensorPickerSingle`: a select-like trigger; opens an anchored popover (min(420px, 92vw),
 *    flips up near the bottom) with search + collapsible component groups; one click picks and
 *    closes; no OK button.
 *  - `SensorPickerMulti`: chips with × plus a dashed "Add…" button opening a 520 px modal with
 *    checkboxes; nothing changes until OK; Cancel / Esc / scrim discard.
 * Labels come from the nearest `SensorMetaProvider`. A list that is not "all sensors" must say
 * which list it is through `scope` ("Sensors on the chart · 4").
 *
 * Rendering cost: groups start collapsed (only the group of the current value opens), so opening
 * the picker on a ~130-tag workspace renders a handful of headers, as the old modal did; the
 * search text per sensor is built once per open.
 */

export const UNCATEGORIZED_GROUP = 'Uncategorized';
export const PICKER_SEARCH_PLACEHOLDER = 'Search description, tag, unit or component…';

type Row =
    | { type: 'group'; comp: string; count: number; on: number; open: boolean }
    | { type: 'item'; tag: string }
    | { type: 'none' };

function initials(c: string): string {
    const w = c.split(/[\s_-]+/).filter(Boolean);
    return ((w[0]?.[0] ?? '') + (w[1]?.[0] ?? w[0]?.[1] ?? '')).toUpperCase();
}

interface PickerListProps {
    sensors: string[];
    query: string;
    setQuery: (q: string) => void;
    isOn: (tag: string) => boolean;
    /** '' = the "None" row. */
    onPick: (tag: string) => void;
    noneRow?: boolean;
    noneOn?: boolean;
    scope?: ReactNode;
    multi?: boolean;
    onEscape: () => void;
    getComponent?: (tag: string) => string;
    /** The search box. */
    inputRef?: RefObject<HTMLInputElement | null>;
    /** Focus the search box on mount (default). The anchored single picker turns this off and
     *  focuses it from `AnchoredPopover`'s `onPlaced`, after the popover has been positioned. */
    focusOnMount?: boolean;
}

/** The searchable, grouped, keyboard-driven list shared by the popover and the modal. */
export function PickerList({ sensors, query, setQuery, isOn, onPick, noneRow, noneOn, scope, multi, onEscape, getComponent, inputRef, focusOnMount = true }: PickerListProps) {
    const lookup = useSensorLookup();
    const ownInput = useRef<HTMLInputElement>(null);
    const searchRef = inputRef ?? ownInput;
    // Not `autoFocus`: that focuses during commit, and WebView2's focus-scroll can fire the
    // capture-phase scroll listener that dismisses an anchored popover. `preventScroll` never scrolls.
    useLayoutEffect(() => {
        if (focusOnMount) searchRef.current?.focus({ preventScroll: true });
        // Mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const compOf = useCallback(
        (t: string) => (getComponent ? getComponent(t) : lookup(t).component) || UNCATEGORIZED_GROUP,
        [getComponent, lookup],
    );
    // Built once per open (the list only mounts while the picker is open).
    const haystacks = useMemo(() => {
        const m = new Map<string, string>();
        for (const s of sensors) {
            const comp = getComponent ? getComponent(s) : '';
            m.set(s, `${sensorHaystack(lookup(s))} ${comp.toLowerCase()}`);
        }
        return m;
    }, [sensors, lookup, getComponent]);

    const [expanded, setExpanded] = useState<Set<string>>(() => {
        // Open the group of the current value(s) so it is visible; small lists open fully.
        const s = new Set<string>();
        for (const t of sensors) if (sensors.length <= 10 || isOn(t)) s.add(compOf(t));
        return s;
    });

    const q = query.trim().toLowerCase();
    const rows = useMemo<Row[]>(() => {
        const list = q ? sensors.filter(s => haystacks.get(s)?.includes(q)) : sensors;
        const map = new Map<string, string[]>();
        for (const s of list) {
            const c = compOf(s);
            let arr = map.get(c);
            if (!arr) { arr = []; map.set(c, arr); }
            arr.push(s);
        }
        const groups = [...map.entries()].sort(([a], [b]) =>
            a === UNCATEGORIZED_GROUP ? 1 : b === UNCATEGORIZED_GROUP ? -1 : a.localeCompare(b));
        const out: Row[] = [];
        if (noneRow && !q) out.push({ type: 'none' });
        const flat = groups.length === 1 && groups[0][0] === UNCATEGORIZED_GROUP;
        for (const [comp, tags] of groups) {
            // A search opens every matching group.
            const open = flat || !!q || expanded.has(comp);
            if (!flat) out.push({ type: 'group', comp, count: tags.length, on: tags.filter(isOn).length, open });
            if (open) for (const t of tags) out.push({ type: 'item', tag: t });
        }
        return out;
    }, [sensors, q, haystacks, compOf, expanded, isOn, noneRow]);
    const itemCount = useMemo(() => rows.filter(r => r.type === 'item').length, [rows]);
    const empty = q !== '' && itemCount === 0;

    const [active, setActive] = useState(-1);
    const listRef = useRef<HTMLDivElement>(null);
    const baseId = useId();
    useEffect(() => { setActive(-1); }, [q]);
    useEffect(() => {
        if (active < 0) return;
        const el = listRef.current?.querySelector(`[data-ix="${active}"]`);
        if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }, [active]);

    const toggleGroup = (c: string, open?: boolean) => setExpanded(prev => {
        const n = new Set(prev);
        const want = open ?? !n.has(c);
        if (want) n.add(c); else n.delete(c);
        return n;
    });
    const act = (r: Row | undefined) => {
        if (!r) return;
        if (r.type === 'group') toggleGroup(r.comp);
        else if (r.type === 'none') onPick('');
        else onPick(r.tag);
    };
    const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        const cur = rows[active];
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(rows.length - 1, a + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(-1, a - 1)); }
        else if (e.key === 'ArrowRight' && cur?.type === 'group') { e.preventDefault(); toggleGroup(cur.comp, true); }
        else if (e.key === 'ArrowLeft' && cur?.type === 'group') { e.preventDefault(); toggleGroup(cur.comp, false); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            // Nothing highlighted but exactly one sensor matches → Enter picks it.
            act(cur ?? (itemCount === 1 ? rows.find(r => r.type === 'item') : undefined));
        } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscape(); }
        // Single popover: the rows are not tab stops, so Tab leaves the picker — close it and hand
        // focus back to the trigger (the next Tab moves on from there) instead of losing focus to
        // the end of the document where the portal lives.
        else if (e.key === 'Tab' && !multi) { e.preventDefault(); onEscape(); }
    };

    return (
        <>
            <div className="pk-search">
                <Search size={13} aria-hidden="true" />
                <input
                    ref={searchRef}
                    type="text"
                    role="combobox"
                    aria-expanded="true"
                    aria-autocomplete="list"
                    aria-controls={`${baseId}-list`}
                    aria-activedescendant={active >= 0 ? `${baseId}-r${active}` : undefined}
                    aria-label="Search sensors"
                    value={query}
                    placeholder={PICKER_SEARCH_PLACEHOLDER}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={onKey}
                />
            </div>
            {scope && <div className="pk-scope">{scope}</div>}
            <div className="pk-list" id={`${baseId}-list`} role="listbox" aria-multiselectable={multi || undefined} ref={listRef}>
                {empty && (
                    <div className="pk-empty">
                        No sensor matches “{query.trim()}”
                        <small>Search looks at description, tag, unit and component.</small>
                    </div>
                )}
                {!empty && sensors.length === 0 && <div className="pk-empty">No sensors to pick from.</div>}
                {rows.map((r, ix) => {
                    const kb = ix === active ? ' kb' : '';
                    const id = `${baseId}-r${ix}`;
                    if (r.type === 'group') {
                        return (
                            // Inside role="listbox" only options / groups are allowed: the header is
                            // a group label row (still clickable; ← → / Enter toggle it from the search box).
                            <button
                                key={`g-${r.comp}`} id={id} data-ix={ix} type="button" tabIndex={-1} role="group"
                                aria-label={`${r.comp}, ${r.count} sensor${r.count === 1 ? '' : 's'}`}
                                className={`pk-g${kb}`} aria-expanded={r.open}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => toggleGroup(r.comp)}
                            >
                                <ChevronRight size={12} className="pk-car" aria-hidden="true" />
                                <span className="pk-badge" aria-hidden="true">{initials(r.comp)}</span>
                                <span className="pk-gname">{r.comp}</span>
                                <span className={`pk-gcount${r.on ? ' on' : ''}`}>{r.on ? `${r.on} / ${r.count}` : r.count}</span>
                            </button>
                        );
                    }
                    if (r.type === 'none') {
                        return (
                            <button
                                key="none" id={id} data-ix={ix} type="button" role="option" tabIndex={-1}
                                aria-selected={!!noneOn} className={`pk-item pk-item--none${kb}${noneOn ? ' on' : ''}`}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => onPick('')}
                            >
                                <span className="pk-mark">{noneOn && <Check size={12} />}</span>None
                            </button>
                        );
                    }
                    const on = isOn(r.tag);
                    const unit = lookup(r.tag).unit;
                    return (
                        <button
                            key={r.tag} id={id} data-ix={ix} type="button" role="option" tabIndex={-1}
                            aria-selected={on} className={`pk-item${kb}${on ? ' on' : ''}`}
                            title={sensorTitle(lookup(r.tag))}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => onPick(r.tag)}
                        >
                            {multi
                                ? <span className="pk-cbx">{on && <Check size={10} strokeWidth={3} />}</span>
                                : <span className="pk-mark">{on && <Check size={12} />}</span>}
                            <SensorInline tag={r.tag} fit />
                            {unit && <span className="unit-badge pk-unit">{unit}</span>}
                        </button>
                    );
                })}
            </div>
        </>
    );
}

/** True while a shared sensor picker (popover or multi modal) or colour picker is open. A
 *  surrounding owner that closes on Esc (a modal, a sheet, an expanded chart) must skip that Esc
 *  then — the picker takes it, and one Esc must not close both. */
export function isPickerSurfaceOpen(): boolean {
    return typeof document !== 'undefined' && document.querySelector('.pk-pop, .pk-scrim, .cp-pop') !== null;
}

/** Closes on a mousedown outside the trigger and the picker's own surface, and on an Esc that
 *  reached the document (focus somewhere other than the search box — the search box handles its
 *  own Esc and stops it). A surrounding owner must ignore that Esc while the picker is open
 *  (`isPickerSurfaceOpen` — the Running condition modal, ChartCard, FailureGroupAssignSheet and
 *  SubModelsModal check it). */
export function usePopoverDismiss(open: boolean, trigger: RefObject<HTMLElement | null>, surfaceClass: string, close: (focusTrigger: boolean) => void) {
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Element | null;
            if (!t) return;
            if (trigger.current?.contains(t)) return;
            if (t.closest?.(`.${surfaceClass}`)) return;
            closeRef.current(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current(true);
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, trigger, surfaceClass]);
}

/** `.pk-pop`'s CSS max-height, `min(380px, 70vh)`, in px. */
export function pickerMaxHeight(): number {
    return typeof window !== 'undefined' ? Math.min(380, Math.round(window.innerHeight * 0.7)) : 380;
}

export interface SensorPickerSingleProps {
    sensors: string[];
    value: string;
    /** '' = "None" (only offered with `allowNone`). */
    onSelect: (tag: string) => void;
    allowNone?: boolean;
    placeholder?: string;
    /** Required-and-empty → dashed amber trigger. */
    required?: boolean;
    disabled?: boolean;
    /** Why it is disabled: the tooltip, and the placeholder when there is no value. */
    disabledReason?: string;
    /** 24 px trigger for chart toolbars. */
    compact?: boolean;
    /** Says which list this is when it is not "all sensors" ("Sensors on the chart · 4"). */
    scope?: ReactNode;
    /** Popover right-aligned to the trigger (keeps it inside a chart's right edge). */
    alignRight?: boolean;
    /** Solid amber border (a filter whose sensor left the chart). */
    warn?: boolean;
    getComponent?: (tag: string) => string;
    ariaLabel?: string;
    className?: string;
    id?: string;
}

export function SensorPickerSingle({
    sensors, value, onSelect, allowNone, placeholder = 'Pick a sensor…', required, disabled, disabledReason,
    compact, scope, alignRight, warn, getComponent, ariaLabel, className = '', id,
}: SensorPickerSingleProps) {
    const lookup = useSensorLookup();
    const [rect, setRect] = useState<PopoverAnchorRect | null>(null);
    const [query, setQuery] = useState('');
    const trig = useRef<HTMLButtonElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const open = () => {
        if (disabled || !trig.current) return;
        const r = trig.current.getBoundingClientRect();
        setQuery('');
        setRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    };
    const close = useCallback((focus = true) => {
        setRect(null);
        if (focus) requestAnimationFrame(() => trig.current?.focus());
    }, []);
    usePopoverDismiss(!!rect, trig, 'pk-pop', close);
    useEffect(() => { if (disabled) setRect(null); }, [disabled]);
    const width = typeof window !== 'undefined' ? Math.min(420, Math.round(window.innerWidth * 0.92)) : 420;
    const empty = !value;
    const isOn = useCallback((t: string) => t === value, [value]);
    const title = disabled && disabledReason ? disabledReason : value ? sensorTitle(lookup(value)) : undefined;
    // An optional picker (`allowNone`) with a value gets a visible × on the trigger, so clearing
    // does not need opening the list and finding "None" (2026-10-09, user report on the
    // Clustering "Criteria sensor (optional)" field). It is a SIBLING of the trigger (a button
    // cannot hold a button), laid over the trigger's right side by `.pk-trigger-wrap`.
    const clearable = !!allowNone && !empty && !disabled;
    const cls = [
        'pk-trigger',
        compact ? 'pk-trigger--sm' : '',
        required && empty && !disabled ? 'req' : '',
        warn ? 'warn' : '',
        clearable ? 'pk-trigger--clearable' : '',
        className,
    ].filter(Boolean).join(' ');
    const clearLabel = `Clear ${ariaLabel ?? 'sensor'}`;
    const trigger = (
        <button
            ref={trig}
            id={id}
            type="button"
            className={cls}
            aria-haspopup="dialog"
            aria-expanded={!!rect}
            aria-label={ariaLabel}
            disabled={disabled}
            title={title}
            onClick={() => (rect ? close() : open())}
            onKeyDown={e => {
                if ((e.key === 'ArrowDown' || e.key === ' ') && !rect) { e.preventDefault(); open(); }
            }}
        >
            {value
                ? <SensorInline tag={value} fit />
                : <span className={`pk-ph${allowNone && !required && !disabled && placeholder === 'None' ? ' pk-ph--none' : ''}`}>
                    {disabled && disabledReason ? disabledReason : placeholder}
                </span>}
            <ChevronDown size={compact ? 12 : 14} className="pk-chev" aria-hidden="true" />
        </button>
    );
    return (
        <>
            {allowNone ? (
                // Always wrapped when `allowNone` (not only while there is a value), so picking a
                // sensor never re-mounts the trigger and loses its focus.
                <span className={`pk-trigger-wrap${compact ? ' pk-trigger-wrap--sm' : ''}`}>
                    {trigger}
                    {clearable && (
                        <button
                            type="button"
                            className="pk-clear"
                            aria-label={clearLabel}
                            title={clearLabel}
                            onClick={() => { if (rect) close(false); onSelect(''); trig.current?.focus(); }}
                        >
                            <X size={compact ? 11 : 13} aria-hidden="true" />
                        </button>
                    )}
                </span>
            ) : trigger}
            {rect && (
                <AnchoredPopover
                    anchorRect={rect}
                    onRequestClose={() => close(false)}
                    width={alignRight ? width : undefined}
                    // `.pk-pop`'s max-height: reserved when it opens above the trigger, so the
                    // search box stays put while the list shrinks (typing) or grows (groups).
                    reserveHeight={pickerMaxHeight()}
                    onPlaced={() => searchRef.current?.focus({ preventScroll: true })}
                    style={{ width, padding: 0, maxHeight: 'none', overflow: 'visible' }}
                >
                    <div className="pk-pop" role="dialog" aria-label={ariaLabel ?? 'Pick a sensor'}>
                        <PickerList
                            sensors={sensors}
                            query={query}
                            setQuery={setQuery}
                            isOn={isOn}
                            onPick={(t) => { onSelect(t); close(); }}
                            noneRow={allowNone}
                            noneOn={allowNone && !value}
                            scope={scope}
                            onEscape={() => close()}
                            getComponent={getComponent}
                            inputRef={searchRef}
                            focusOnMount={false}
                        />
                    </div>
                </AnchoredPopover>
            )}
        </>
    );
}

export interface SensorPickerMultiProps {
    sensors: string[];
    selected: string[];
    /** Fires with the full new selection on OK, or when a chip's × removes one. */
    onConfirm: (tags: string[]) => void;
    /** Plural noun for the modal title and the empty "Add …" button, e.g. "predictors". */
    noun: string;
    /** Says which list this is when it is not "all sensors". */
    scope?: ReactNode;
    /** Required-and-empty → amber "Add …" button. */
    required?: boolean;
    /** Locked: chips without ×, "Add…" disabled showing the reason. */
    lockedReason?: string;
    disabled?: boolean;
    getComponent?: (tag: string) => string;
    /** Render no chips (the caller renders its own). */
    hideChips?: boolean;
}

export function SensorPickerMulti({
    sensors, selected, onConfirm, noun, scope, required, lockedReason, disabled, getComponent, hideChips,
}: SensorPickerMultiProps) {
    const lookup = useSensorLookup();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<string[]>(selected);
    const [query, setQuery] = useState('');
    const addRef = useRef<HTMLButtonElement>(null);
    const blocked = !!lockedReason || !!disabled;
    const start = () => { if (blocked) return; setPending(selected); setQuery(''); setOpen(true); };
    const close = () => { setOpen(false); requestAnimationFrame(() => addRef.current?.focus()); };
    useEffect(() => { if (blocked) setOpen(false); }, [blocked]);
    const pendingSet = useMemo(() => new Set(pending), [pending]);
    const isOn = useCallback((t: string) => pendingSet.has(t), [pendingSet]);
    return (
        <div className="pk-multi">
            {!hideChips && selected.map(t => {
                const i = lookup(t);
                return (
                    <span key={t} className={`pk-chip${lockedReason ? ' pk-chip--locked' : ''}`} title={sensorTitle(i)}>
                        <SensorInline tag={t} size="sm" />
                        {!blocked && (
                            <button
                                type="button" className="pk-chip-x"
                                aria-label={`Remove ${i.description || t}`}
                                onClick={() => onConfirm(selected.filter(s => s !== t))}
                            >
                                <X size={12} />
                            </button>
                        )}
                    </span>
                );
            })}
            <button
                ref={addRef}
                type="button"
                className={`pk-add${required && selected.length === 0 ? ' req' : ''}`}
                onClick={start}
                disabled={blocked}
                title={lockedReason}
                aria-haspopup="dialog"
            >
                {lockedReason ? <Lock size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
                {lockedReason ?? (selected.length ? 'Add…' : `Add ${noun}…`)}
            </button>
            {open && (
                <Portal>
                    <div className="pk-scrim" role="presentation" onMouseDown={close}>
                        <div
                            className="pk-modal"
                            role="dialog"
                            aria-modal="true"
                            aria-label={`Select ${noun}`}
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => e.stopPropagation()}
                            onKeyDown={e => {
                                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
                                if (e.key === 'Tab') {
                                    // Keep focus inside the modal.
                                    const f = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"]):not(:disabled)')];
                                    const i = f.indexOf(document.activeElement as HTMLElement);
                                    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]?.focus(); }
                                    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0]?.focus(); }
                                }
                            }}
                        >
                            <div className="pk-mh">
                                <span>Select {noun}</span>
                                <button type="button" aria-label="Close" onClick={close}><X size={15} /></button>
                            </div>
                            <PickerList
                                sensors={sensors}
                                query={query}
                                setQuery={setQuery}
                                isOn={isOn}
                                onPick={(t) => { if (!t) return; setPending(p => (p.includes(t) ? p.filter(x => x !== t) : [...p, t])); }}
                                scope={scope}
                                multi
                                onEscape={close}
                                getComponent={getComponent}
                            />
                            <div className="pk-foot">
                                <span className="pk-count">{pending.length} selected</span>
                                <span className="pk-foot-btns">
                                    <button type="button" className="pk-btn" onClick={close}>Cancel</button>
                                    <button type="button" className="pk-btn pk-btn--pri" onClick={() => { onConfirm(pending); close(); }}>
                                        <Check size={13} /> OK
                                    </button>
                                </span>
                            </div>
                        </div>
                    </div>
                </Portal>
            )}
        </div>
    );
}
