import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { groupDeleteCounts, modelSensorKey } from '../../utils/modelGrouping';
import { groupDeleteText } from './groupDeleteText';
import { Check, Plus, Search, X, Pencil, Trash2 } from 'lucide-react';
import Portal from '../Portal';
import { SensorLabel } from '../sensor/SensorLabel';
import type { SensorInfo } from '../sensor/sensorInfo';
import { isPickerSurfaceOpen } from '../sensor/SensorPicker';
import type { FailureGroup, FailureModel, ModelKind } from '../../types';
import { MODEL_KIND_LABEL, kindModelName } from '../../utils/modelNames';
import { normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { UNDO_SECONDS } from './UndoToastStack';
import { isDuplicateFailureGroupName } from './failureGroupOps';

export const KIND_LETTER: Record<ModelKind, string> = {
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};
/** App-wide kind names (`utils/modelNames.ts`); in a sentence use `kindModelName`, never "Relation model model". */
export const KIND_LABEL: Record<ModelKind, string> = MODEL_KIND_LABEL;
export const ALL_KINDS: ModelKind[] = ['individual', 'relationship', 'clustering'];

/** How long the "model deleted — Undo" toast stays up. Defined in `UndoToastStack.tsx` so the Import page can share it; re-exported for existing importers. */
export { UNDO_SECONDS };

// Sheet geometry (px): docks to the LEFT edge of the Sensors panel, full height, extending over the chart area.
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
    /** The sensor's metadata for the header — rendered as the same stacked label as
     *  the row that opened it. */
    info: SensorInfo;
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
    /** True `returnFocus` (Esc, ✕, Done): the caller refocuses the opener; a click outside passes false. */
    onClose: (opts?: { returnFocus?: boolean }) => void;
    /** "Assign sensors →": the group being filled. Its row is pinned first,
     *  highlighted and tagged "Assigning". */
    pinnedGroupNo?: number | null;
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

/** "Failure Group Assignment": full-height sheet docked left of the Sensors panel; a matrix of Failure Group rows x model-kind columns, with a pinned "Not in Group" row. Presentation + local UI state only: changes go through the Dashboard's handlers. Rendered via `Portal` with a measured `position: fixed` rect (ancestors are `overflow: hidden`); re-measures on scroll/resize. */
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

    // Clicking outside the sheet and the Sensors panel closes it (clicks inside the panel just move the sheet).
    // `mousedown` + capture so a chart that stops click propagation still dismisses it.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target;
            if (!(target instanceof Node)) return;
            if (sheetRef.current?.contains(target)) return;
            if (live.current.getHostEl()?.contains(target)) return;
            if (target instanceof Element && target.closest('[data-fg-sheet-keep]')) return;
            live.current.onClose({ returnFocus: false });
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
                aria-label={`Failure groups for ${props.info.description || tag}`}
                data-testid="fg-sheet"
                style={style}
            >
                {geom?.notchTop != null && (
                    <span className="fg-sheet-notch" data-testid="fg-sheet-notch" aria-hidden="true" style={{ top: geom.notchTop }} />
                )}
                {/* Keyed by sensor: switching sensors resets search, All/Assigned view, the "Assigned" bucket and any row menu, like opening fresh. */}
                <SheetBody key={tag} {...props} onClose={onClose} />
            </div>
        </Portal>
    );
}

function SheetBody({
    tag, info, fgGroups, fgModels, getGroupColor,
    onToggleSensorGroupKind, onCreateGroupForSensor, onRenameGroup, onDeleteGroup,
    canStepPrev, canStepNext, onStep, onClose, pinnedGroupNo = null,
}: FailureGroupAssignSheetProps) {
    const tagKey = normalizeSensorTag(tag);
    const listRef = useRef<HTMLDivElement>(null);

    const [query, setQuery] = useState('');
    const [view, setView] = useState<'all' | 'assigned'>('all');
    // "Assigned" bucket is fixed when the sheet opens, so toggling a cell never moves a row; only groups created/deleted here change it.
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

    // Shared duplicate rule (also refuses "Not in Group"), so the sheet says why a name is refused.
    const hasName = (name: string, exceptNo?: number) => isDuplicateFailureGroupName(fgGroups, name, exceptNo);

    const q = query.trim().toLowerCase();
    const matches = (g: FailureGroup) => !q || g.name.toLowerCase().includes(q) || `fg-${g.no}`.includes(q);

    // The group an "Assign sensors" run is filling is pinned above both sections regardless of the All/Assigned view.
    const pinned = pinnedGroupNo ? realGroups.find(g => g.no === pinnedGroupNo) ?? null : null;
    const showPinned = !!pinned && matches(pinned);
    const assignedRows = snapshot
        .map(no => realGroups.find(g => g.no === no))
        .filter((g): g is FailureGroup => !!g && g !== pinned && matches(g));
    const otherRows = realGroups
        .filter(g => g !== pinned && !snapshot.includes(g.no) && (view !== 'assigned' || isInAny(g.no)) && matches(g));

    // A kind's column header: how many groups the sensor's model of that kind
    // belongs to right now (not filtered by the search box).
    const kindCount = (kind: ModelKind) => {
        const m = modelOfKind(kind);
        if (!m) return 0;
        return m.groupNos.filter(n => n === 0 || fgGroups.some(g => g.no === n)).length;
    };

    const sub = useRef({ renameFor, confirmFor, menuFor });
    sub.current = { renameFor, confirmFor, menuFor };
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // A picker open over the sheet closes itself on this Esc; don't close the sheet too.
            if (isPickerSurfaceOpen()) return;
            const s = sub.current;
            if (s.renameFor !== null) { setRenameFor(null); setRenameError(''); }
            else if (s.confirmFor !== null) setConfirmFor(null);
            else if (s.menuFor !== null) setMenuFor(null);
            else onCloseRef.current({ returnFocus: true });
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

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

    // Find the new group by name once the Dashboard adds it to `fgGroups`; pin it into "Assigned", flash and scroll to it.
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

    // The delete confirm can push its row under the pinned "Not in Group" bar in a short window; centre the row.
    useEffect(() => {
        if (confirmFor === null) return;
        const row = listRef.current?.querySelector(`[data-group-no="${confirmFor}"]`);
        (row as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    }, [confirmFor]);

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

    const renderCell = (group: { no: number; name: string }, kind: ModelKind) => {
        const on = isOn(group.no, kind);
        const model = modelOfKind(kind);
        // Removing a model's LAST group deletes the whole model (settings and training) and the Dashboard offers an Undo; say so on the cell before the click.
        const last = on && !!model && model.groupNos.length === 1;
        const label = KIND_LABEL[kind];
        const title = on
            ? (last
                ? `Remove ${label} from ${group.name} — this deletes the sensor's ${kindModelName(kind)} (you can undo for ${UNDO_SECONDS} seconds)`
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
        const isPinned = g === pinned;
        const rowClass = `fg-sheet-row fg-sheet-grid ${colorClass}${inRow ? ' fg-sheet-row--in' : ''}${flashNo === g.no ? ' fg-sheet-row--flash' : ''}${isPinned ? ' fg-sheet-row--pinned' : ''}`;

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
        const counts = groupDeleteCounts(fgModels, g.no);
        return (
            <div key={g.no} className={rowClass} data-group-no={g.no} data-testid={`fg-sheet-row-${g.no}`}>
                <span className="fg-group-dot fg-sheet-dot" />
                <div className="fg-sheet-name">
                    <span className="fg-sheet-gname" title={g.name}>{g.name}</span>
                    {isPinned
                        ? <span className="fg-sheet-assigning" title={`FG-${g.no}`}>Assigning</span>
                        : <span className="fg-sheet-gno">FG-{g.no}</span>}
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
                        <span>{groupDeleteText(g.name, counts.deleted, counts.kept)}</span>
                        <button type="button" className="fg-sheet-btn" onClick={() => setConfirmFor(null)}>Cancel</button>
                        <button type="button" className="fg-sheet-btn fg-sheet-btn--danger" onClick={() => confirmDelete(g.no)}>Delete</button>
                    </div>
                )}
            </div>
        );
    };

    const none = { no: 0, name: 'Not in Group' };
    const nothingToShow = assignedRows.length === 0 && otherRows.length === 0 && !showPinned;

    return (
        <>
            <div className="fg-sheet-head">
                <div className="fg-sheet-title">
                    <div className="fg-sheet-kicker">Failure groups</div>
                    <SensorLabel tag={tag} info={info} className="fg-sheet-sl" wrap />
                </div>
                <div className="fg-sheet-step">
                    <button type="button" className="row-action-btn" title="Previous sensor" aria-label="Previous sensor" disabled={!canStepPrev} onClick={() => onStep(-1)}>‹</button>
                    <button type="button" className="row-action-btn" title="Next sensor" aria-label="Next sensor" disabled={!canStepNext} onClick={() => onStep(1)}>›</button>
                </div>
                <button type="button" className="row-action-btn" title="Close (Esc)" aria-label="Close" onClick={() => onClose({ returnFocus: true })}>
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

                {showPinned && renderRow(pinned!)}
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

                {/* "Not in Group" (FG-0): per-kind cells like a real group, no rename/delete; always pinned at the bottom regardless of search. */}
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
                <button type="button" className="fg-sheet-btn fg-sheet-btn--primary" onClick={() => onClose({ returnFocus: true })}>Done</button>
            </div>
            {/* Says what Enter/Create do: `createGroupForSensor` puts only THIS sensor's Individual model (reused or new) in the new group. */}
            {createError
                ? <div className="fg-sheet-err" role="alert">{createError}</div>
                : <div className="fg-sheet-hint" data-testid="fg-sheet-hint">Enter creates the group and adds this sensor&rsquo;s Individual model to it.</div>}
        </>
    );
}
