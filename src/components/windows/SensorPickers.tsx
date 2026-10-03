import { useState, useEffect, useRef, useMemo } from "react";
import { Check, Search, X, ChevronRight, ChevronDown } from "lucide-react";

// 2026-10-04 (Health score phase 4): moved out of PredictiveModelBuild.tsx
// when that page was deleted — these two pickers are shared by the Build Model
// Workbench (BuildModelWindow, ModelFitPage, RunningConditionPanel). Props,
// behaviour and CSS classes are unchanged.

// ── Reusable Sensor Autocomplete ─────────────────────────────────────
// Exported so BuildModelWindow.tsx's "Running Condition Filter" panel (the
// one place a filter's sensor is picked now — see that file) can reuse the
// exact same search UI instead of a second implementation drifting from
// this one.
export interface SensorAutocompleteProps {
    sensors: string[];
    getDesc: (tag: string) => string;
    value: string;
    onSelect: (tag: string) => void;
    placeholder?: string;
    excluded?: string[];
    clearOnSelect?: boolean;
    allowNone?: boolean;
    disabled?: boolean;
    style?: React.CSSProperties;
    /** When provided, the dropdown groups matches under a header per
     *  component (alphabetical, same "Uncategorized" fallback used
     *  elsewhere) instead of one flat list — lets a long sensor list be
     *  scanned by equipment area. Omit to keep the flat list. */
    getComponent?: (tag: string) => string;
}

export function SensorAutocomplete({
    sensors, getDesc, value, onSelect, placeholder, excluded = [],
    clearOnSelect = false, allowNone = false, disabled = false, style, getComponent,
}: SensorAutocompleteProps) {
    const [query, setQuery] = useState(value);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => { if (!open) setQuery(value); }, [value, open]);

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
                setQuery(value);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [value]);

    const filtered = sensors.filter(s => {
        if (excluded.includes(s)) return false;
        const q = query.trim().toLowerCase();
        if (!q) return true;
        if (s.toLowerCase().includes(q)) return true;
        return getDesc(s).toLowerCase().includes(q);
    });

    // Component groups, alphabetical — same "Uncategorized" fallback used
    // elsewhere (BuildModelWindow's own Group-by-Component view). Only
    // computed when a caller opts in via `getComponent`.
    const groupedFiltered = useMemo(() => {
        if (!getComponent) return null;
        const groups = new Map<string, string[]>();
        for (const s of filtered) {
            const comp = getComponent(s) || 'Uncategorized';
            if (!groups.has(comp)) groups.set(comp, []);
            groups.get(comp)!.push(s);
        }
        return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [filtered, getComponent]);

    const handleSelect = (tag: string) => {
        onSelect(tag);
        setQuery(clearOnSelect ? '' : tag);
        setOpen(false);
    };

    const renderItem = (s: string) => {
        const desc = getDesc(s);
        return (
            <button
                type="button"
                key={s}
                className={`sensor-autocomplete-item ${s === value ? 'selected' : ''}`}
                onClick={() => handleSelect(s)}
            >
                <span className="sensor-autocomplete-item-tag">{s}</span>
                {desc && <span className="sensor-autocomplete-item-desc">{desc}</span>}
            </button>
        );
    };

    return (
        <div className="sensor-autocomplete" ref={wrapRef} style={style}>
            <div className="sensor-autocomplete-input-wrap">
                <Search size={12} className="sensor-autocomplete-icon" />
                <input
                    type="text"
                    className="sensor-autocomplete-input"
                    value={query}
                    onChange={e => { setQuery(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    placeholder={placeholder}
                    disabled={disabled}
                />
                {query && !disabled && (
                    <button
                        type="button"
                        className="sensor-autocomplete-clear"
                        onClick={() => { setQuery(''); if (!clearOnSelect) onSelect(''); setOpen(true); }}
                        title="Clear"
                    >
                        <X size={12} />
                    </button>
                )}
            </div>
            {open && !disabled && (
                <div className="sensor-autocomplete-list">
                    {allowNone && (
                        <button type="button" className="sensor-autocomplete-item sensor-autocomplete-item--none" onClick={() => handleSelect('')}>
                            <span className="sensor-autocomplete-item-tag"><em>None</em></span>
                        </button>
                    )}
                    {filtered.length === 0 ? (
                        <div className="sensor-autocomplete-empty">No sensors found</div>
                    ) : groupedFiltered ? groupedFiltered.map(([comp, tags]) => (
                        <div key={comp}>
                            <div className="sensor-autocomplete-group-header">{comp}</div>
                            {tags.map(renderItem)}
                        </div>
                    )) : filtered.map(renderItem)}
                </div>
            )}
        </div>
    );
}

// ── Reusable Sensor Picker popup (multi- or single-select) ───────────
// Exported alongside SensorAutocomplete for the same reason — every page that
// picks sensors this way (BuildModelWindow's Relationship/Clustering forms,
// this page's own Predictor/X/Criteria sensor fields) shouldn't drift into
// separate implementations.
//
// 2026-09-22: introduced (as "PredictorPickerModal", multi-select only) to
// replace the inline SensorAutocomplete/native <select> that used to sit
// directly in these forms. Extended the same day to also cover single-select
// fields (X sensor, Y sensor, criteria sensor) — per explicit user request,
// after trying the multi-select popup: "ใช้เป็นการเลือกแบบเดียวกันเลย แต่
// ต้องเลือกได้แค่ตัวเดียว ตาม concept ของ model" (Y/criteria are conceptually
// single-value; the model can't have two). One component, `single` selects
// the mode:
//   - multi (default): checkboxes, staged in local `pending` state, only
//     committed via `onConfirm(tags)` on OK — Cancel/Escape/backdrop-click
//     discard. Trigger is a dashed "Add …" button.
//   - single: clicking a row selects it and closes immediately via
//     `onSelect(tag)` — there's only one value, nothing to batch, so no
//     OK/Cancel footer. Trigger looks like a real input, showing the
//     current `value`'s label (or `placeholder` when empty).
// Search + collapsible per-component groups (mirrors Dashboard's
// SensorSelection.tsx — everything starts collapsed, and a non-empty search
// forces every matching group open) work identically in both modes.
// SensorAutocomplete itself is untouched and still used for genuine
// type-to-filter-as-you-go fields (the "Running Condition Filter" panel's
// sensor picker) where a popup would be overkill.
export interface SensorPickerModalProps {
    sensors: string[];
    getDesc: (tag: string) => string;
    /** Omit to render one flat, unlabeled group instead of per-component
     *  sections — mirrors SensorAutocomplete's own `getComponent` contract. */
    getComponent?: (tag: string) => string;
    /** Never offered (e.g. the model's own target sensor). */
    excluded?: string[];
    /** Header title and trigger text/placeholder default from this, e.g.
     *  "predictor sensors", "X sensor", "criteria sensor". */
    noun: string;
    disabled?: boolean;
    /** false (default) = multi-select; true = single-select. See the
     *  component doc comment above for the behavioral difference. */
    single?: boolean;

    // ── multi-select props (used when `single` is false/omitted) ──
    /** The last CONFIRMED selection — what the popup starts from every time
     *  it opens, discarding anything left over from a cancelled attempt. */
    selected?: string[];
    /** Fires once, with the full new selection, when the user clicks OK.
     *  Never called on Cancel or backdrop-click. */
    onConfirm?: (tags: string[]) => void;

    // ── single-select props (used when `single` is true) ──
    value?: string;
    onSelect?: (tag: string) => void;
    /** Adds a "— None —" row above the list that clears the selection. */
    allowNone?: boolean;
    /** Overrides the trigger's empty-state text (default: "Pick {noun}...")
     *  — e.g. to explain WHY it's disabled ("No predictors selected"). */
    placeholder?: string;
    /** Single mode: render the tag muted after the description ("desc (TAG)")
     *  - the condition-row look from the approved mockup. Text content is the
     *  same either way. */
    mutedTag?: boolean;
    /** Multi mode: trigger text override (default "Add {noun}..."), e.g.
     *  "3 selected. Edit predictors...". */
    triggerText?: string;
    /** Marks the field as required-and-empty (amber border), as in the
     *  approved mockup. Presentation only. */
    invalid?: boolean;
}

const UNCATEGORIZED_GROUP = 'Uncategorized';

export function SensorPickerModal({
    sensors, getDesc, getComponent, excluded = [], noun, disabled = false, single = false,
    selected = [], onConfirm, value = '', onSelect, allowNone = false, placeholder, mutedTag = false, triggerText, invalid = false,
}: SensorPickerModalProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // Staged selection (multi mode only) — only committed to `selected` (via
    // onConfirm) on OK, so Cancel/Escape/backdrop-click can throw it away
    // with zero side effects. Single mode has nothing to stage: a click
    // selects and closes in the same step.
    const [pending, setPending] = useState<string[]>(selected);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

    const openPicker = () => {
        if (disabled) return;
        setPending(selected);
        setQuery('');
        setExpandedGroups(new Set());
        setOpen(true);
    };

    // Same Escape-closes-the-modal convention as the chart expand/sub-models
    // modals elsewhere on this page. Discards (same as Cancel/backdrop-click).
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    const selectable = useMemo(() => sensors.filter(s => !excluded.includes(s)), [sensors, excluded]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return selectable;
        return selectable.filter(s => s.toLowerCase().includes(q) || getDesc(s).toLowerCase().includes(q));
    }, [selectable, query, getDesc]);

    const groups = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const s of filtered) {
            const comp = getComponent ? (getComponent(s) || UNCATEGORIZED_GROUP) : '';
            if (!map.has(comp)) map.set(comp, []);
            map.get(comp)!.push(s);
        }
        return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [filtered, getComponent]);

    // Same rule as Dashboard's SensorSelection: browsing wants groups
    // collapsed by default; actively searching wants every match visible.
    const isGroupExpanded = (comp: string) => query.trim() !== '' || expandedGroups.has(comp);
    const toggleGroup = (comp: string) => setExpandedGroups(prev => {
        const next = new Set(prev);
        if (next.has(comp)) next.delete(comp); else next.add(comp);
        return next;
    });

    const togglePending = (tag: string) => setPending(prev =>
        prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);

    const handleItemClick = (tag: string) => {
        if (single) {
            onSelect?.(tag);
            setOpen(false);
        } else {
            togglePending(tag);
        }
    };

    const handleConfirm = () => { onConfirm?.(pending); setOpen(false); };
    const handleCancel = () => setOpen(false);

    const selectedLabel = value ? (getDesc(value) ? `${getDesc(value)} (${value})` : value) : '';

    return (
        <>
            {single ? (
                <button
                    type="button"
                    className={`sensor-picker-trigger-single${invalid ? ' sensor-picker-trigger--req' : ''}`}
                    onClick={openPicker}
                    disabled={disabled}
                >
                    {/* Plain inline icon, NOT `.sensor-autocomplete-icon` —
                        that class is `position: absolute`, meant to overlay
                        a real <input> inside `.sensor-autocomplete-input-wrap`
                        (which is `position: relative`). This button has no
                        such wrapper, so the icon escaped to the nearest
                        positioned ancestor up the tree and rendered off in a
                        random spot (regression reported 2026-09-22, fixed
                        same day). A flex child needs no positioning trick. */}
                    <Search size={12} className="sensor-picker-trigger-icon" />
                    <span className={`sensor-picker-trigger-label${selectedLabel ? '' : ' sensor-picker-trigger-placeholder'}`}>
                        {mutedTag && value && getDesc(value)
                            ? <>{getDesc(value)} <i className="sensor-picker-tag">({value})</i></>
                            : selectedLabel || placeholder || `Pick ${noun}...`}
                    </span>
                </button>
            ) : (
                <button
                    type="button"
                    className={`predictor-picker-trigger${invalid ? ' sensor-picker-trigger--req' : ''}`}
                    onClick={openPicker}
                    disabled={disabled}
                >
                    <Search size={12} />
                    <span>{triggerText ?? `Add ${noun}…`}</span>
                </button>
            )}
            {open && (
                <div className="predictor-picker-backdrop" onClick={handleCancel} role="presentation">
                    <div
                        className="predictor-picker-modal"
                        onClick={e => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Select ${noun}`}
                    >
                        <div className="predictor-picker-header">
                            <span>Select {noun}</span>
                            <button type="button" className="predictor-picker-close" onClick={handleCancel} aria-label="Close">
                                <X size={16} />
                            </button>
                        </div>
                        <div className="sensor-autocomplete-input-wrap predictor-picker-search">
                            <Search size={12} className="sensor-autocomplete-icon" />
                            <input
                                type="text"
                                className="sensor-autocomplete-input"
                                autoFocus
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Search sensor tag or description..."
                            />
                        </div>
                        <div className="predictor-picker-list">
                            {single && allowNone && (
                                <button
                                    type="button"
                                    className="predictor-picker-item predictor-picker-item--none"
                                    onClick={() => handleItemClick('')}
                                >
                                    <em>None</em>
                                </button>
                            )}
                            {groups.length === 0 ? (
                                <div className="sensor-autocomplete-empty">No sensors found</div>
                            ) : groups.map(([comp, tags]) => {
                                const groupExpanded = isGroupExpanded(comp);
                                const checkedInGroup = single ? 0 : tags.filter(t => pending.includes(t)).length;
                                return (
                                    <div key={comp || '__flat__'} className="predictor-picker-group">
                                        {comp && (
                                            <button
                                                type="button"
                                                className="predictor-picker-group-header"
                                                onClick={() => toggleGroup(comp)}
                                                aria-expanded={groupExpanded}
                                            >
                                                {groupExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                <span className="predictor-picker-group-name">{comp}</span>
                                                <span className={checkedInGroup > 0 ? 'pm-count-pill' : 'predictor-picker-group-count'}>
                                                    {checkedInGroup > 0 ? `${checkedInGroup}/${tags.length}` : tags.length}
                                                </span>
                                            </button>
                                        )}
                                        {(groupExpanded || !comp) && tags.map(tag => {
                                            const desc = getDesc(tag);
                                            const checked = single ? tag === value : pending.includes(tag);
                                            return single ? (
                                                <button
                                                    type="button"
                                                    key={tag}
                                                    className={`predictor-picker-item${checked ? ' checked' : ''}`}
                                                    onClick={() => handleItemClick(tag)}
                                                >
                                                    <span className="predictor-picker-item-tag">{tag}</span>
                                                    {desc && <span className="predictor-picker-item-desc">{desc}</span>}
                                                </button>
                                            ) : (
                                                <label key={tag} className={`predictor-picker-item${checked ? ' checked' : ''}`}>
                                                    <input type="checkbox" checked={checked} onChange={() => togglePending(tag)} />
                                                    <span className="predictor-picker-item-tag">{tag}</span>
                                                    {desc && <span className="predictor-picker-item-desc">{desc}</span>}
                                                </label>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                        {!single && (
                            <div className="predictor-picker-footer">
                                <span className="predictor-picker-count">{pending.length} selected</span>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <button type="button" className="pm-btn pm-btn-secondary" onClick={handleCancel}>Cancel</button>
                                    <button type="button" className="pm-btn pm-btn-primary" onClick={handleConfirm}>
                                        <Check size={13} /> OK
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
