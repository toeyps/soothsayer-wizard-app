import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, Plus, Search, X, Pencil, Trash2 } from 'lucide-react';
import Portal from '../Portal';
import type { FailureGroup, FailureModel, ModelKind } from '../../types';
import { modelSensorKey } from '../../utils/modelGrouping';
import { normalizeSensorTag } from '../../hooks/useSensorMetaMap';

export const KIND_LETTER: Record<ModelKind, string> = {
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};
export const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};
export const ALL_KINDS: ModelKind[] = ['individual', 'relationship', 'clustering'];

/** How long the "model deleted — Undo" toast (Dashboard.tsx) stays up. Lives
 *  here only because this sheet's last-group cell tooltip promises it. */
export const UNDO_SECONDS = 7;

// Sheet geometry (px). The sheet docks to the LEFT edge of the Sensors panel,
// full height of that panel, and extends over the chart area to its left.
const GAP = 10;      // space between the sheet and the Sensors panel
const EDGE = 8;      // minimum distance to the window's left edge
const MIN_W = 340;   // below this the matrix columns would crush the group names
const MAX_W = 560;

interface Geom { left: number; top: number; width: number; height: number; notchTop: number | null }

const sameGeom = (a: Geom, b: Geom) =>
    a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.notchTop === b.notchTop;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface FailureGroupAssignSheetProps {
    /** Tag of the sensor being edited. */
    tag: string;
    /** What to call it in the header: its description, or the bare tag. */
    sensorLabel: string;
    unit?: string;
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    getGroupColor: (groupNo: number) => string;
    onToggleSensorGroupKind: (tag: string, groupNo: number, kind: ModelKind) => void;
    onCreateGroupForSensor: (tag: string, name: string) => void;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    canStepPrev: boolean;
    canStepNext: boolean;
    onStep: (direction: -1 | 1) => void;
    onClose: () => void;
    /** The Sensors panel — the sheet docks to its left edge, and a click
     *  anywhere inside it never closes the sheet. */
    getHostEl: () => HTMLElement | null;
    /** The sensor row being edited (the arrow points at it). */
    getRowEl: () => HTMLElement | null;
    /** The scrolling sensor list (the arrow hides when the row scrolls out). */
    getListEl: () => HTMLElement | null;
}

/** Group numbers (never 0) that this sensor belongs to in ANY kind, in group order. */
function assignedGroupNos(groups: FailureGroup[], models: FailureModel[], tagKey: string): number[] {
    const own = models.filter(m => modelSensorKey(m) === tagKey);
    return groups
        .filter(g => g.no !== 0 && own.some(m => m.groupNos.includes(g.no)))
        .map(g => g.no);
}

/**
 * "Failure Group Assignment" — the full-height sheet docked to the left edge of
 * the Dashboard's Sensors panel that replaced the old `AnchoredPopover` menu
 * (2026-10-03). One matrix: a row per Failure Group x a column per model kind
 * (Individual / Relationship / Clustering), plus the permanent "Not in Group"
 * row pinned at the bottom.
 *
 * Presentation + local UI state only. Every change goes through the Dashboard's
 * existing handlers (`onToggleSensorGroupKind`, `onCreateGroupForSensor`,
 * `onRenameGroup`, `onDeleteGroup`), so persistence, cross-window broadcasts and
 * the stale-mirror protection all stay where they were.
 *
 * Rendered through `Portal` (the Sensors panel and its ancestors are all
 * `overflow: hidden`, so an in-place sheet reaching LEFT of the panel would be
 * clipped) and placed with a measured `position: fixed` rect, the same
 * technique `AnchoredPopover` already uses. Unlike that popover it is NOT
 * dismissed by scroll/resize — it re-measures instead — because the user is
 * expected to scroll the sensor list while it is open.
 */
export default function FailureGroupAssignSheet(props: FailureGroupAssignSheetProps) {
    const { tag, onClose } = props;
    const sheetRef = useRef<HTMLDivElement>(null);
    const [geom, setGeom] = useState<Geom | null>(null);

    // Latest accessors/callbacks without making every effect below re-subscribe
    // whenever the parent re-renders with new inline closures.
    const live = useRef(props);
    live.current = props;

    const measure = useCallback(() => {
        const host = live.current.getHostEl();
        if (!host) return;
        const hr = host.getBoundingClientRect();
        // No layout (jsdom, or the panel is hidden): fall back to the CSS defaults.
        if (hr.width <= 0 || hr.height <= 0) { setGeom(null); return; }
        const width = clamp(hr.left - GAP - EDGE, MIN_W, MAX_W);
        const left = Math.max(EDGE, hr.left - GAP - width);
        let notchTop: number | null = null;
        const row = live.current.getRowEl();
        if (row) {
            const rr = row.getBoundingClientRect();
            const lr = (live.current.getListEl() ?? host).getBoundingClientRect();
            const cy = rr.top + rr.height / 2;
            // Only point at the row while it is actually visible in the list.
            if (rr.height > 0 && cy >= lr.top && cy <= lr.bottom) {
                notchTop = clamp(cy - hr.top - 6, 14, Math.max(14, hr.height - 26));
            }
        }
        const next: Geom = { left, top: hr.top, width, height: hr.height, notchTop };
        setGeom(prev => (prev && sameGeom(prev, next) ? prev : next));
    }, []);

    useLayoutEffect(() => { measure(); }, [measure, tag]);

    useEffect(() => {
        const onScroll = (e: Event) => {
            // A scroll INSIDE the sheet (its own list) does not move the row.
            if (sheetRef.current && e.target instanceof Node && sheetRef.current.contains(e.target)) return;
            measure();
        };
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', onScroll, true);
        // The split.js gutter resizes the Sensors panel without any window resize.
        const host = live.current.getHostEl();
        let ro: ResizeObserver | null = null;
        if (host && typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => measure());
            ro.observe(host);
        }
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', onScroll, true);
            ro?.disconnect();
        };
    }, [measure]);

    // Clicking anywhere OUTSIDE the sheet and the Sensors panel — the chart,
    // the title bar, the other Dashboard panels — closes it. Clicks inside the
    // panel never do (that is the whole point: pick another sensor's 📁 and the
    // sheet follows). `mousedown` + capture so a chart that stops its own
    // click propagation still dismisses it.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target;
            if (!(target instanceof Node)) return;
            if (sheetRef.current?.contains(target)) return;
            if (live.current.getHostEl()?.contains(target)) return;
            if (target instanceof Element && target.closest('[data-fg-sheet-keep]')) return;
            live.current.onClose();
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
    }, []);

    const style: CSSProperties | undefined = geom
        ? { left: geom.left, top: geom.top, width: geom.width, height: geom.height, right: 'auto', bottom: 'auto' }
        : undefined;

    return (
        <Portal>
            <div
                ref={sheetRef}
                className="fg-sheet popover-surface"
                role="dialog"
                aria-label={`Failure groups for ${props.sensorLabel}`}
                data-testid="fg-sheet"
                style={style}
            >
                {geom?.notchTop != null && (
                    <span className="fg-sheet-notch" data-testid="fg-sheet-notch" aria-hidden="true" style={{ top: geom.notchTop }} />
                )}
                {/* Keyed by sensor: switching sensors resets the search, the
                    All/Assigned view, the "Assigned" bucket and any open row menu,
                    exactly like opening the sheet fresh. */}
                <SheetBody key={tag} {...props} onClose={onClose} />
            </div>
        </Portal>
    );
}

function SheetBody({
    tag, sensorLabel, unit, fgGroups, fgModels, getGroupColor,
    onToggleSensorGroupKind, onCreateGroupForSensor, onRenameGroup, onDeleteGroup,
    canStepPrev, canStepNext, onStep, onClose,
}: FailureGroupAssignSheetProps) {
    const tagKey = normalizeSensorTag(tag);
    const listRef = useRef<HTMLDivElement>(null);

    const [query, setQuery] = useState('');
    const [view, setView] = useState<'all' | 'assigned'>('all');
    // The "Assigned" bucket is decided ONCE, when the sheet opens for this
    // sensor, so toggling a cell never makes a row jump between sections — it
    // just changes colour in place. Groups created/deleted from the sheet are
    // the only later edits to it.
    const [snapshot, setSnapshot] = useState<number[]>(() => assignedGroupNos(fgGroups, fgModels, tagKey));
    const [menuFor, setMenuFor] = useState<number | null>(null);
    const [renameFor, setRenameFor] = useState<number | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    const [renameError, setRenameError] = useState('');
    const [confirmFor, setConfirmFor] = useState<number | null>(null);
    const [newName, setNewName] = useState('');
    const [createError, setCreateError] = useState('');
    const [pendingCreate, setPendingCreate] = useState<string | null>(null);
    const [flashNo, setFlashNo] = useState<number | null>(null);

    const ownModels = useMemo(
        () => fgModels.filter(m => modelSensorKey(m) === tagKey),
        [fgModels, tagKey],
    );
    const modelOfKind = (kind: ModelKind) => ownModels.find(m => m.kind === kind);
    const isOn = (groupNo: number, kind: ModelKind) => modelOfKind(kind)?.groupNos.includes(groupNo) ?? false;
    const isInAny = (groupNo: number) => ALL_KINDS.some(k => isOn(groupNo, k));

    const realGroups = fgGroups.filter(g => g.no !== 0);
    const assignedNow = realGroups.filter(g => isInAny(g.no)).length;

    const hasName = (name: string, exceptNo?: number) =>
        fgGroups.some(g => g.no !== 0 && g.no !== exceptNo && g.name.trim().toLowerCase() === name.trim().toLowerCase());

    const q = query.trim().toLowerCase();
    const matches = (g: FailureGroup) => !q || g.name.toLowerCase().includes(q) || `fg-${g.no}`.includes(q);

    const assignedRows = snapshot
        .map(no => realGroups.find(g => g.no === no))
        .filter((g): g is FailureGroup => !!g && matches(g));
    const otherRows = realGroups
        .filter(g => !snapshot.includes(g.no) && (view !== 'assigned' || isInAny(g.no)) && matches(g));

    // A kind's column header: how many groups the sensor's model of that kind
    // belongs to right now (not filtered by the search box).
    const kindCount = (kind: ModelKind) => {
        const m = modelOfKind(kind);
        if (!m) return 0;
        return m.groupNos.filter(n => n === 0 || fgGroups.some(g => g.no === n)).length;
    };

    // ── Esc: peel off the innermost thing first, close the sheet last ────────
    const sub = useRef({ renameFor, confirmFor, menuFor });
    sub.current = { renameFor, confirmFor, menuFor };
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const s = sub.current;
            if (s.renameFor !== null) { setRenameFor(null); setRenameError(''); }
            else if (s.confirmFor !== null) setConfirmFor(null);
            else if (s.menuFor !== null) setMenuFor(null);
            else onCloseRef.current();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    // ── Create ────────────────────────────────────────────────────────────────
    const commitCreate = () => {
        const name = newName.trim();
        if (!name) return;
        if (hasName(name)) {
            setCreateError(`A failure group named "${name}" already exists`);
            return;
        }
        onCreateGroupForSensor(tag, name);
        setPendingCreate(name.toLowerCase());
        setNewName('');
        setCreateError('');
        setQuery('');
        setView('all');
    };

    // The Dashboard assigns the group's number, so look the new group up by name
    // once it shows up in `fgGroups`; then pin it into "Assigned" (the creator
    // gives this sensor an Individual model in it), flash it and scroll to it.
    useEffect(() => {
        if (!pendingCreate) return;
        const g = fgGroups.find(x => x.no !== 0 && x.name.trim().toLowerCase() === pendingCreate);
        if (!g) return;
        setPendingCreate(null);
        setSnapshot(s => (s.includes(g.no) ? s : [...s, g.no]));
        setFlashNo(g.no);
    }, [fgGroups, pendingCreate]);

    useEffect(() => {
        if (flashNo === null) return;
        const row = listRef.current?.querySelector(`[data-group-no="${flashNo}"]`);
        (row as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
        const timer = setTimeout(() => setFlashNo(null), 1300);
        return () => clearTimeout(timer);
    }, [flashNo]);

    // The inline delete confirm makes its row taller; in a short window that can
    // push it under the pinned "Not in Group" bar. Centre the row so the whole
    // confirm (and its buttons) is on screen.
    useEffect(() => {
        if (confirmFor === null) return;
        const row = listRef.current?.querySelector(`[data-group-no="${confirmFor}"]`);
        (row as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    }, [confirmFor]);

    // ── Rename / delete ──────────────────────────────────────────────────────
    const startRename = (g: FailureGroup) => {
        setRenameFor(g.no);
        setRenameDraft(g.name);
        setRenameError('');
        setMenuFor(null);
    };
    const commitRename = () => {
        if (renameFor === null) return;
        const name = renameDraft.trim();
        const current = fgGroups.find(g => g.no === renameFor);
        if (!name || (current && name === current.name)) { setRenameFor(null); setRenameError(''); return; }
        if (hasName(name, renameFor)) { setRenameError(`A failure group named "${name}" already exists`); return; }
        onRenameGroup(renameFor, name);
        setRenameFor(null);
        setRenameError('');
    };
    const confirmDelete = (groupNo: number) => {
        onDeleteGroup(groupNo);
        setSnapshot(s => s.filter(n => n !== groupNo));
        setConfirmFor(null);
        setMenuFor(null);
    };

    // ── Rendering ────────────────────────────────────────────────────────────
    const renderCell = (group: { no: number; name: string }, kind: ModelKind) => {
        const on = isOn(group.no, kind);
        const model = modelOfKind(kind);
        // Removing a model's LAST group deletes the whole model (settings and
        // training included) — the Dashboard then offers a 7s Undo. Say so
        // before the click, on the cell itself.
        const last = on && !!model && model.groupNos.length === 1;
        const label = KIND_LABEL[kind];
        const title = on
            ? (last
                ? `Remove ${label} from ${group.name} — this deletes the sensor's ${label} model (you can undo for ${UNDO_SECONDS} seconds)`
                : `Remove ${label} from ${group.name}`)
            : `Add ${label} to ${group.name}`;
        return (
            <button
                key={kind}
                type="button"
                className={`fg-sheet-cell fg-sheet-cell--${kind}${on ? ' is-on' : ''}`}
                aria-pressed={on}
                aria-label={`${label} · ${group.name}`}
                title={title}
                data-kind={kind}
                data-last={last ? 'true' : undefined}
                onClick={() => onToggleSensorGroupKind(tag, group.no, kind)}
            >
                {on ? <Check size={16} strokeWidth={3} /> : <span className="fg-sheet-plus"><Plus size={16} /></span>}
            </button>
        );
    };

    const renderRow = (g: FailureGroup) => {
        const colorClass = `fg-group-color-${getGroupColor(g.no)}`;
        const inRow = isInAny(g.no);
        const rowClass = `fg-sheet-row fg-sheet-grid ${colorClass}${inRow ? ' fg-sheet-row--in' : ''}${flashNo === g.no ? ' fg-sheet-row--flash' : ''}`;

        if (renameFor === g.no) {
            return (
                <div key={g.no} className={rowClass} data-group-no={g.no} data-testid={`fg-sheet-row-${g.no}`}>
                    <span className="fg-group-dot fg-sheet-dot" />
                    <input
                        className="fg-sheet-input fg-sheet-renamefield"
                        value={renameDraft}
                        autoFocus
                        aria-label="Group name"
                        aria-invalid={renameError ? true : undefined}
                        onFocus={e => e.currentTarget.select()}
                        onChange={e => { setRenameDraft(e.target.value); setRenameError(''); }}
                        onKeyDown={e => { if (e.key === 'Enter') commitRename(); }}
                    />
                    <button type="button" className="row-action-btn" title="Save name (Enter)" aria-label="Save name" onClick={commitRename}>
                        <Check size={14} />
                    </button>
                    {renameError && <div className="fg-sheet-err fg-sheet-err--row" role="alert">{renameError}</div>}
                </div>
            );
        }

        const menuOpen = menuFor === g.no;
        const confirming = confirmFor === g.no;
        const lostModels = fgModels.filter(m => m.groupNos.includes(g.no)).length;
        return (
            <div key={g.no} className={rowClass} data-group-no={g.no} data-testid={`fg-sheet-row-${g.no}`}>
                <span className="fg-group-dot fg-sheet-dot" />
                <div className="fg-sheet-name">
                    <span className="fg-sheet-gname" title={g.name}>{g.name}</span>
                    <span className="fg-sheet-gno">FG-{g.no}</span>
                </div>
                {menuOpen ? (
                    <>
                        <div className="fg-sheet-acts">
                            <button type="button" className="fg-sheet-btn" onClick={() => startRename(g)}>
                                <Pencil size={13} />Rename
                            </button>
                            <button
                                type="button"
                                className="fg-sheet-btn fg-sheet-btn--danger-o"
                                onClick={() => { setConfirmFor(g.no); setMenuFor(null); }}
                            >
                                <Trash2 size={13} />Delete…
                            </button>
                        </div>
                        <div className="fg-sheet-more">
                            <button type="button" className="row-action-btn" title="Back" aria-label="Back" onClick={() => setMenuFor(null)}>
                                <X size={13} />
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        {ALL_KINDS.map(kind => renderCell(g, kind))}
                        <div className="fg-sheet-more">
                            {!confirming && (
                                <button
                                    type="button"
                                    className="row-action-btn fg-sheet-dots"
                                    title="Rename or delete group"
                                    aria-label={`Group actions: ${g.name}`}
                                    onClick={() => setMenuFor(g.no)}
                                >
                                    ⋯
                                </button>
                            )}
                        </div>
                    </>
                )}
                {confirming && (
                    <div className="fg-sheet-confirm" role="alertdialog" aria-label={`Delete ${g.name}`}>
                        <span>
                            Delete <b>{g.name}</b> for every sensor? {lostModels} model{lostModels === 1 ? '' : 's'} lose this group.
                        </span>
                        <button type="button" className="fg-sheet-btn" onClick={() => setConfirmFor(null)}>Cancel</button>
                        <button type="button" className="fg-sheet-btn fg-sheet-btn--danger" onClick={() => confirmDelete(g.no)}>Delete</button>
                    </div>
                )}
            </div>
        );
    };

    const none = { no: 0, name: 'Not in Group' };
    const nothingToShow = assignedRows.length === 0 && otherRows.length === 0;

    return (
        <>
            <div className="fg-sheet-head">
                <div className="fg-sheet-title">
                    <div className="fg-sheet-kicker">Failure groups</div>
                    <div className="fg-sheet-sensor" title={sensorLabel}>{sensorLabel}</div>
                    <div className="sensor-row-tag">{tag}{unit ? ` · ${unit}` : ''}</div>
                </div>
                <div className="fg-sheet-step">
                    <button type="button" className="row-action-btn" title="Previous sensor" aria-label="Previous sensor" disabled={!canStepPrev} onClick={() => onStep(-1)}>‹</button>
                    <button type="button" className="row-action-btn" title="Next sensor" aria-label="Next sensor" disabled={!canStepNext} onClick={() => onStep(1)}>›</button>
                </div>
                <button type="button" className="row-action-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
                    <X size={15} />
                </button>
            </div>

            <div className="fg-sheet-tools">
                <label className="fg-sheet-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                        type="text"
                        value={query}
                        placeholder={`Search ${realGroups.length} groups…`}
                        aria-label="Search failure groups"
                        onChange={e => setQuery(e.target.value)}
                    />
                </label>
                <div className="fg-sheet-seg" role="group" aria-label="Show groups">
                    <button type="button" className={view === 'all' ? 'on' : ''} aria-pressed={view === 'all'} onClick={() => setView('all')}>
                        All <span className="fg-sheet-num">{realGroups.length}</span>
                    </button>
                    <button type="button" className={view === 'assigned' ? 'on' : ''} aria-pressed={view === 'assigned'} onClick={() => setView('assigned')}>
                        Assigned <span className="fg-sheet-num">{assignedNow}</span>
                    </button>
                </div>
            </div>

            <div className="fg-sheet-list" ref={listRef}>
                <div className="fg-sheet-grid fg-sheet-colh">
                    <span />
                    <span>Failure group</span>
                    {ALL_KINDS.map(kind => {
                        const n = kindCount(kind);
                        return (
                            <span key={kind} className="fg-sheet-ch" data-kind={kind}>
                                <span className={`kind-badge kind-badge--${kind}`}>{KIND_LETTER[kind]}</span>
                                {KIND_LABEL[kind]}
                                <small className={n ? 'has' : ''}>{n ? `${n} group${n > 1 ? 's' : ''}` : 'none'}</small>
                            </span>
                        );
                    })}
                    <span />
                </div>

                {assignedRows.length > 0 && (
                    <>
                        <div className="fg-sheet-sec">Assigned</div>
                        {assignedRows.map(renderRow)}
                    </>
                )}
                {otherRows.length > 0 && (
                    <>
                        <div className="fg-sheet-sec">{assignedRows.length > 0 ? 'Other groups' : 'All groups'}</div>
                        {otherRows.map(renderRow)}
                    </>
                )}
                {nothingToShow && (
                    <div className="fg-sheet-empty">
                        {q
                            ? `No groups match “${query.trim()}”`
                            : realGroups.length
                                ? 'Not in any failure group yet'
                                : 'No failure groups yet'}
                    </div>
                )}

                {/* "Not in Group" (FG-0): same per-kind cells as a real group, but
                    no rename/delete — a permanent bucket for a sensor that has a
                    model without belonging to a failure mode yet. Pinned to the
                    bottom of the list whatever the search/filter says. */}
                <div className="fg-sheet-none">
                    <div className={`fg-sheet-grid fg-sheet-row fg-group-color-slate${isInAny(0) ? ' fg-sheet-row--in' : ''}`} data-group-no={0} data-testid="fg-sheet-row-0">
                        <span className="fg-group-dot fg-sheet-dot" />
                        <div className="fg-sheet-name"><span className="fg-sheet-gname">Not in Group</span></div>
                        {ALL_KINDS.map(kind => renderCell(none, kind))}
                        <span />
                    </div>
                </div>
            </div>

            <div className="fg-sheet-foot">
                <input
                    type="text"
                    className={`fg-sheet-input${createError ? ' is-bad' : ''}`}
                    value={newName}
                    placeholder="New failure group name"
                    aria-label="New failure group name"
                    aria-invalid={createError ? true : undefined}
                    onChange={e => { setNewName(e.target.value); setCreateError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') commitCreate(); }}
                />
                <button type="button" className="fg-sheet-btn" disabled={!newName.trim()} onClick={commitCreate}>
                    <Plus size={13} />Create
                </button>
                <button type="button" className="fg-sheet-btn fg-sheet-btn--primary" onClick={onClose}>Done</button>
            </div>
            {createError && <div className="fg-sheet-err" role="alert">{createError}</div>}
        </>
    );
}
