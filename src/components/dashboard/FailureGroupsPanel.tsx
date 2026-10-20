import { useState, useEffect, useMemo } from 'react';
import { groupDeleteCounts } from '../../utils/modelOutputFiles';
import { groupDeleteText } from './groupDeleteText';
import { Plus, Trash2, Play, ChevronRight, Check, FolderPlus } from 'lucide-react';
import { FailureGroup, FailureModel, FailureGroupStateSlice, ModelKind, SensorMetadata, SpecialSensorRecipe } from '../../types';
import { SensorLabel } from '../sensor/SensorLabel';
import { SensorMetaContext, sensorHaystack, sensorTitle, useLayeredSensorLookup } from '../sensor/sensorInfo';
import { groupModelsBySensor, type SensorModelGroup } from '../../utils/modelGrouping';
import { MODEL_KIND_LABEL } from '../../utils/modelNames';
import type { RunningConditionFg } from '../../utils/runningCondition';
import { isModelComplete, modelDotState, modelSetPointFlag } from '../../utils/modelStatus';
import { summarizeFailureGroups } from '../../utils/failureGroupSummary';
import { isDuplicateFailureGroupName } from './failureGroupOps';

// The app-wide kind names (Individual / Relation model / Clustering) — used
// for the model-kind badge's tooltip (see renderModelRow below).
const KIND_LABEL = MODEL_KIND_LABEL;

interface FailureGroupsPanelProps {
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    sensorMetadata: SensorMetadata[] | null;
    /** Workspace running-condition state (everything BuildModelWindow.tsx's
     *  own `gateFg` carries except `models` — Dashboard's `fgExtra` mirror is
     *  exactly this shape already). Combined with `fgModels` above (spread
     *  in as `models`) to answer the same "is this model's build gate
     *  blocked" / "is this model trained-and-fresh" questions the Workbench
     *  answers for its own status pill/dot — see `dotStatusFor` below. */
    runningConditionFg: Omit<FailureGroupStateSlice, 'groups' | 'models'>;
    /** Dataset headers (Dashboard's `allSensorTags`), or `null` when none
     *  loaded yet — same `gateHeaders` role as BuildModelWindow.tsx's own,
     *  needed so `getBuildBlockReason` can tell a configured-but-now-missing
     *  running-condition sensor apart from a merely-unconfigured one. */
    datasetHeaders: string[] | null;
    /** The workspace's special-sensor recipes: a model trained on a special sensor
     *  whose formula changed since reads as out of date here too. Pass the
     *  Dashboard's state array (stable identity — the signatures are memoised per array). */
    specialSensorRecipes?: SpecialSensorRecipe[] | null;
    getGroupColor: (groupNo: number) => string;
    /** Saves Name + Description + Recommendation together (the name is only
     *  editable together with the rest of the detail, not separately). */
    onUpdateGroupDetails: (groupNo: number, name: string, description: string, recommendation: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    onCreateEmptyGroup: (name: string) => void;
    /** Deletes a model record outright. Model lifecycle (creation, via the
     *  Sensor tab's per-kind toggle, and deletion, here) lives entirely on
     *  Dashboard; Build Model only edits/trains models. */
    onDeleteModel: (modelId: string) => void;
    /** Opens the (singleton) Build Model window — for editing a model's
     *  detail (category, notes, predictors, cluster ranges, kind, …) and
     *  training it. Cards themselves still don't open anything on click. */
    onOpenBuildModel: () => void;
    /** "Assign sensors →" on a group with no sensors yet: the Dashboard switches
     *  to the Sensor tab in assign mode for that group. Omitted = no link. */
    onAssignSensors?: (groupNo: number) => void;
}

// The same duplicate rule as the Dashboard's own group writers and Import step 3.
const isDuplicateName = isDuplicateFailureGroupName;

/**
 * Group-centric view for the Dashboard's Sensor panel — Failure Groups tab.
 * Each card shows the group's name/ID and every model inside it — the
 * model's own name if one was set, otherwise the target sensor's
 * description — so the whole group is scannable at a glance, plus a delete
 * button per model. Each card also has its own "Edit details" toggle (Name +
 * Description + Recommendation together).
 *
 * A small status DOT sits at the corner of each sensor row's I/R/C kind
 * badge (see `dotStatusFor` below). It reads the same status rules as
 * BuildModelWindow.tsx (`utils/modelStatus.ts`), so the two views can never
 * disagree about a model's state.
 *
 * Model creation happens on the Sensor tab (per-kind toggle on each sensor,
 * see SensorSelection.tsx); this panel handles deletion (a trash icon per
 * model row). Build Model only edits a model's own detail and trains it.
 */
export default function FailureGroupsPanel({
    fgGroups, fgModels, sensorMetadata, runningConditionFg, datasetHeaders, specialSensorRecipes, getGroupColor,
    onUpdateGroupDetails, onDeleteGroup, onCreateEmptyGroup, onDeleteModel, onOpenBuildModel, onAssignSensors,
}: FailureGroupsPanelProps) {
    // "Edit details" panel — Name + Description + Recommendation together,
    // one group expanded at a time. Mirrors Build Model window's own
    // version exactly (moved here, not duplicated — see the doc comment
    // above and this component's own top-level doc comment).
    const [expandedGroupNo, setExpandedGroupNo] = useState<number | null>(null);
    // Deleting a group deletes the models that are only in it: ask first.
    const [confirmDeleteNo, setConfirmDeleteNo] = useState<number | null>(null);
    const [groupNameDraft, setGroupNameDraft] = useState('');
    const [groupNameError, setGroupNameError] = useState('');
    const [groupDescDraft, setGroupDescDraft] = useState('');
    const [groupRecDraft, setGroupRecDraft] = useState('');
    // Which sensor lines are expanded, keyed `${groupNo}:${sensorKey}` — the
    // per-model rows (with their delete buttons) live inside the expansion.
    const [expandedSensors, setExpandedSensors] = useState<Set<string>>(new Set());
    const toggleSensor = (id: string) => setExpandedSensors(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [newGroupDraft, setNewGroupDraft] = useState('');
    const [newGroupError, setNewGroupError] = useState('');
    // Search box: filters which sensor lines render within each group (and
    // hides a group entirely once its name and every one of its sensors
    // fail to match). Two-level match: a group-NAME match keeps every
    // sensor in that group, a sensor match on its own only keeps that
    // sensor. Display-only; does not touch which models/groups exist.
    const [fgSearch, setFgSearch] = useState('');

    // Rows use the same stacked label as the Sensor tab, from this panel's own
    // metadata layered on the window's provider (special-sensor badges come through).
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);

    // `RunningConditionFg` needs `models` too (category derivation falls back
    // to it when a model's own `category` is null) — `fgModels` is already a
    // separate top-level prop here, so it's spread in rather than asking the
    // caller to pass it twice.
    const fg: RunningConditionFg = { ...runningConditionFg, models: fgModels };

    // Status comes from `utils/modelStatus.ts`, the single definition the
    // Build Model window reads too, so the two views never disagree. A model
    // that's fingerprint-fresh but blocked by a gate reason (e.g. a running-
    // condition sensor missing from the dataset) reads as 'none', never
    // 'trained'. A Complete model that is out of date (its inputs changed
    // since it was trained) is NOT complete here either. `stale`/`blocked`
    // draw no dot.
    //
    // A TRAINED model whose saved set points Rust rejected / left empty reads
    // red / yellow — `modelSetPointFlag` (utils/modelStatus.ts) reads the
    // verdict persisted on the model (`healthVerdict`), the same value the
    // Build Model list dot and tab pill read.
    const dotStatusFor = (m: FailureModel): 'none' | 'trained' | 'complete' | 'need' | 'bad' => {
        const s = modelDotState(m, fg, datasetHeaders, specialSensorRecipes);
        if (s === 'trained') {
            const flag = modelSetPointFlag(m, fg, datasetHeaders, s, specialSensorRecipes);
            return flag === 'fix' ? 'bad' : flag === 'needed' ? 'need' : 'trained';
        }
        return s === 'complete' ? s : 'none';
    };
    const isDone = (m: FailureModel): boolean => isModelComplete(m, fg, specialSensorRecipes);
    // Model name if the user set one; otherwise the target sensor's
    // description (clustering's "target" is its Y sensor, same convention
    // as component derivation elsewhere); falls back to the raw tag, then a
    // generic placeholder for a brand-new model with no sensor picked yet.
    //
    // A name that's identical to the target tag itself doesn't count as "the
    // user set one" — legacy workspaces default a model's name to its sensor
    // tag (see workspaceManager.ts's migration shim), so without this check
    // every migrated model would permanently show its raw tag here instead of
    // ever falling through to the sensor's description.
    //
    // The tag itself is always appended in parens when the target sensor is
    // known, so several models named after the same sensor description can be
    // told apart at a glance.
    const modelDisplayLabel = (model: FailureModel) => {
        // Clustering's Y sensor stays blank until configured in Build Model
        // (Dashboard.tsx's makeDefaultModelForKind seeds X only) — falling
        // back to X here keeps this label the same "description (tag)"
        // shape Individual/Relationship always show, instead of silently
        // dropping the tag, which the user flagged as an inconsistency
        // ("i/r เหมือนกัน แต่ c ไม่เหมือนกัน").
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const trimmedName = model.name.trim();
        if (!targetTag) return trimmedName || 'Untitled model';
        const label = (trimmedName && trimmedName !== targetTag) ? trimmedName : sensorLookup(targetTag).description;
        return label ? `${label} (${targetTag})` : targetTag;
    };

    // A trash icon per model row (no confirmation dialog) and a colored kind
    // badge (I/R/C), so two models of the same sensor in different kinds can
    // be told apart. The badge uses `.kind-badge`/`.kind-badge--*`; it never
    // carries a status dot (the sensor row above it already shows one per
    // kind).
    const renderModelRow = (model: FailureModel) => (
        <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div
                className={`kind-badge kind-badge--${model.kind}`}
                title={KIND_LABEL[model.kind]}
                style={{ width: '16px', height: '16px', borderRadius: '4px', fontSize: '0.56rem', flexShrink: 0 }}
            >
                {model.kind.charAt(0).toUpperCase()}
            </div>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                {modelDisplayLabel(model)}
            </span>
            <button
                className="fg-icon-btn fg-icon-btn-danger"
                title="Delete model"
                onClick={() => onDeleteModel(model.id)}
                style={{ flexShrink: 0, width: '18px', height: '18px' }}
            >
                <Trash2 size={10} />
            </button>
        </div>
    );

    // One collapsible line per SENSOR per group: the header shows the sensor
    // once plus a mini chip per kind that exists; the per-model rows (and
    // their delete buttons) sit inside the expansion. No category control
    // here — category is set on Build Model's sensor header.
    //
    // The I/R/C badge SHELL uses `.kind-badge`/`.kind-badge--*`; the corner
    // STATUS DOT uses `.f4-kb-dot`/`.f4-kb-dot--*`. Do not rename the dot
    // class: `BuildModelWorkbenchStatusDotCrossWindow.integration.test.tsx`
    // reads it with a `/f4-kb-dot--(\w+)/` regex, and a rename would make that
    // assertion silently read back "none" for every state instead of failing.
    const renderSensorRow = (groupNo: number, sg: SensorModelGroup) => {
        const id = `${groupNo}:${sg.key}`;
        const open = expandedSensors.has(id);
        const first = sg.models[0];
        const keyTag = first.kind === 'clustering' ? first.xSensor : first.targetSensor;
        const info = keyTag ? sensorLookup(keyTag) : undefined;
        const label = info ? sensorTitle(info) : modelDisplayLabel(first);
        const kinds = (['individual', 'relationship', 'clustering'] as ModelKind[]).filter(k => sg.models.some(m => m.kind === k));
        return (
            <div key={id} data-testid={`fg-sensor-row-${id}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                        type="button"
                        onClick={() => toggleSensor(id)}
                        aria-expanded={open}
                        title={info ? undefined : label}
                        aria-label={info ? label : undefined}
                        className="fg-srow-btn"
                    >
                        <ChevronRight size={11} style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />
                        {/* The stacked label, row metrics matching the Sensor tab rows exactly. */}
                        {info && keyTag
                            ? <SensorLabel tag={keyTag} info={info} />
                            : <span className="fg-srow-plain">{label}</span>}
                    </button>
                    {kinds.map(k => {
                        // One model per (sensor, kind) across the whole
                        // workspace (Dashboard.tsx's `toggleSensorGroupKind`/
                        // `findKindIn` enforce this) — `sg.models` here is
                        // already scoped to this one FG, so at most one match.
                        const kindModel = sg.models.find(m => m.kind === k);
                        const dot = kindModel ? dotStatusFor(kindModel) : 'none';
                        return (
                            <span
                                key={k}
                                className={`kind-badge kind-badge--${k}`}
                                title={KIND_LABEL[k]}
                                style={{ width: '18px', height: '18px', fontSize: '0.56rem', flexShrink: 0 }}
                            >
                                {k.charAt(0).toUpperCase()}
                                {dot !== 'none' && (
                                    <span
                                        data-testid={`fg-kind-badge-dot-${groupNo}-${sg.key}-${k}`}
                                        className={`f4-kb-dot f4-kb-dot--${dot}`}
                                        aria-hidden="true"
                                    />
                                )}
                            </span>
                        );
                    })}
                </div>
                {open && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', margin: '4px 0 2px 15px', paddingLeft: '8px', borderLeft: '1px solid var(--border)' }}>
                        {sg.models.map(m => renderModelRow(m))}
                    </div>
                )}
            </div>
        );
    };

    const realGroups = [...fgGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    // "N groups · M sensors assigned · x of y models complete". Memoised on
    // the Failure Group data alone, so a Dashboard re-render from a chart
    // hover/pan never re-walks the models. `x` uses `isModelComplete`, the
    // same rule as `isDone` and the per-group counters.
    const summary = useMemo(
        () => summarizeFailureGroups(fgGroups, fgModels, { ...runningConditionFg, models: fgModels }),
        [fgGroups, fgModels, runningConditionFg],
    );
    // Real groups that no model belongs to yet: they get "Assign sensors →",
    // and while one exists the landing callout keeps pointing at that step.
    const emptyGroupNos = useMemo(() => {
        const used = new Set<number>();
        for (const m of fgModels) for (const no of m.groupNos) used.add(no);
        return new Set(fgGroups.filter(g => g.no !== 0 && !used.has(g.no)).map(g => g.no));
    }, [fgGroups, fgModels]);
    // Group 0 ("Not in Group") is a permanent sentinel carried in fgGroups
    // for models built against a sensor that isn't part of any failure
    // mode. Always rendered as its own card, so there is always an entry
    // point to get a model into it.
    const ungroupedModels = fgModels.filter(m => m.groupNos.includes(0));

    // Search box filtering, two-level match: a GROUP NAME match keeps every
    // sensor line in that card; otherwise only sensor lines whose own
    // description/tag matches survive, and a group with none left (and a
    // non-matching name) is hidden entirely. Display/filter only — never
    // touches which groups/models exist.
    const searchQuery = fgSearch.trim().toLowerCase();
    const sensorMatchesQuery = (sg: SensorModelGroup) => {
        if (!searchQuery) return true;
        const first = sg.models[0];
        const keyTag = first.kind === 'clustering' ? first.xSensor : first.targetSensor;
        return keyTag ? sensorHaystack(sensorLookup(keyTag)).includes(searchQuery) : false;
    };
    const visibleSensorGroups = (groupNo: number, groupName: string): { visible: boolean; sensorGroups: SensorModelGroup[] } => {
        const all = groupModelsBySensor(fgModels, groupNo);
        if (!searchQuery || groupName.toLowerCase().includes(searchQuery)) return { visible: true, sensorGroups: all };
        const filtered = all.filter(sensorMatchesQuery);
        return { visible: filtered.length > 0, sensorGroups: filtered };
    };

    const toggleGroupDetails = (g: FailureGroup) => {
        if (expandedGroupNo === g.no) {
            setExpandedGroupNo(null);
            return;
        }
        setExpandedGroupNo(g.no);
        setGroupNameDraft(g.name);
        setGroupNameError('');
        setGroupDescDraft(g.description ?? '');
        setGroupRecDraft(g.recommendation ?? '');
    };

    // Debounced save (250ms). `toggleGroupDetails` seeds the drafts to match
    // the group's current values on expand, so this naturally no-ops until
    // the user actually changes something.
    useEffect(() => {
        if (expandedGroupNo === null) return;
        const g = realGroups.find(x => x.no === expandedGroupNo);
        if (!g) return;
        const trimmedName = groupNameDraft.trim();
        if (trimmedName === g.name && groupDescDraft === (g.description ?? '') && groupRecDraft === (g.recommendation ?? '')) return;
        const timer = setTimeout(() => {
            if (!trimmedName) return;
            if (isDuplicateName(realGroups, trimmedName, expandedGroupNo)) {
                setGroupNameError(`A failure group named "${trimmedName}" already exists`);
                return;
            }
            setGroupNameError('');
            onUpdateGroupDetails(expandedGroupNo, trimmedName, groupDescDraft, groupRecDraft);
        }, 250);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupNameDraft, groupDescDraft, groupRecDraft, expandedGroupNo]);

    const commitNewGroup = () => {
        const trimmed = newGroupDraft.trim();
        if (!trimmed) return;
        if (isDuplicateName(realGroups, trimmed)) {
            setNewGroupError(`A failure group named "${trimmed}" already exists`);
            return;
        }
        onCreateEmptyGroup(trimmed);
        setNewGroupDraft('');
        setNewGroupError('');
        setShowNewGroup(false);
    };

    // "Not in Group" goes through the same search visibility rule as a
    // real group (see `visibleSensorGroups` above) — computed once here
    // since it isn't part of the `realGroups.map()` below.
    const notInGroupVisible = visibleSensorGroups(0, 'Not in Group');

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="fg-panel-widget" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Search -> summary chip -> legend, same header shell as the
                Sensor tab's own search box. */}
            <div className="widget-header" style={{ flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                <input
                    type="text"
                    placeholder="Search groups or sensors..."
                    value={fgSearch}
                    onChange={e => setFgSearch(e.target.value)}
                    className="search-input-compact"
                />
                <div className="fg-summary-chip" data-testid="fg-summary">
                    <span>
                        <b>{summary.groupCount}</b> group{summary.groupCount === 1 ? '' : 's'}
                        {' · '}<b>{summary.assignedSensorCount}</b> sensor{summary.assignedSensorCount === 1 ? '' : 's'} assigned
                        {' · '}<b>{summary.completeModelCount}</b> of {summary.totalModelCount} models complete
                    </span>
                </div>
                <div className="fg-legend">
                    {/* No dot here on purpose — matches what an actual
                        untrained badge renders below (renderSensorRow gates
                        its dot on `dot !== 'none'`, so a never-trained model
                        shows NO dot at all, not a neutral/ringed one). */}
                    <span>Not trained</span>
                    <span><i className="fg-legend-dot fg-legend-dot--trained" />Trained</span>
                    <span><i className="fg-legend-dot fg-legend-dot--complete" />Complete</span>
                </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {/* Landing callout: after Import step 3, and on any project that
                    still has no groups or an empty group. Names the lucide button,
                    never an emoji. */}
                {realGroups.length === 0 ? (
                    <div className="fg-callout" data-testid="fg-callout">
                        <b>No failure groups yet.</b> Failure groups come first: create one below, then assign the sensors that show it. You can explore the charts meanwhile.
                    </div>
                ) : emptyGroupNos.size > 0 ? (
                    <div className="fg-callout" data-testid="fg-callout">
                        <b>Your failure groups are ready.</b> Next, assign the sensors that show each failure: open the <b>Sensor</b> tab and use the Failure groups button
                        {' '}<FolderPlus size={12} className="fg-callout-icon" aria-hidden="true" />{' '}
                        on a sensor row, or click <b>Assign sensors</b> on a group.
                    </div>
                ) : null}
                {realGroups.map(group => {
                    const groupModels = fgModels.filter(m => m.groupNos.includes(group.no));
                    const doneInGroup = groupModels.filter(isDone).length;
                    const color = getGroupColor(group.no);
                    const isExpanded = expandedGroupNo === group.no;
                    const { visible, sensorGroups } = visibleSensorGroups(group.no, group.name);
                    if (!visible) return null;
                    return (
                        <div
                            key={group.no}
                            className={`fg-group-color-${color} fg-group-card`}
                            style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}
                        >
                            <div className="fg-row">
                                <span className="fg-group-dot" />
                                <span className="fg-row-name">
                                    {group.name}
                                </span>
                                <span className="fg-row-no">FG-{group.no}</span>
                                <div className="fg-row-actions">
                                    <button className="text-btn" style={{ fontSize: '0.66rem' }} onClick={() => toggleGroupDetails(group)}>
                                        {isExpanded ? 'Hide details' : 'Edit details'}
                                    </button>
                                    <button
                                        className="fg-icon-btn fg-icon-btn-danger"
                                        title="Delete group"
                                        aria-expanded={confirmDeleteNo === group.no}
                                        onClick={() => setConfirmDeleteNo(n => (n === group.no ? null : group.no))}
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                                <span className="fg-row-count">
                                    {groupModels.length > 0 ? <><b>{doneInGroup}</b> / {groupModels.length}</> : '0'}
                                </span>
                            </div>

                            {confirmDeleteNo === group.no && (
                                <GroupDeleteConfirm
                                    name={group.name}
                                    {...groupDeleteCounts(fgModels, group.no)}
                                    onCancel={() => setConfirmDeleteNo(null)}
                                    onConfirm={() => { setConfirmDeleteNo(null); onDeleteGroup(group.no); }}
                                />
                            )}

                            {isExpanded && (
                                <div className="fg-group-edit">
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        <label style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Name</label>
                                        <input
                                            value={groupNameDraft}
                                            onChange={e => { setGroupNameDraft(e.target.value); setGroupNameError(''); }}
                                            style={{ padding: '5px 7px', background: 'var(--input-bg)', border: `1px solid ${groupNameError ? 'var(--danger, #e2555f)' : 'var(--border)'}`, borderRadius: '5px', color: 'var(--text-primary)', fontSize: '0.78rem', fontWeight: 600 }}
                                        />
                                        {groupNameError && <div style={{ fontSize: '0.62rem', color: 'var(--danger, #e2555f)' }}>{groupNameError}</div>}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        <label style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Description</label>
                                        <textarea
                                            rows={2}
                                            value={groupDescDraft}
                                            placeholder="What failure mode does this group track?"
                                            onChange={e => setGroupDescDraft(e.target.value)}
                                            style={{ resize: 'vertical', padding: '5px 7px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-primary)', fontSize: '0.72rem' }}
                                        />
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        <label style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Recommendation</label>
                                        <textarea
                                            rows={2}
                                            value={groupRecDraft}
                                            placeholder="Recommended action when this failure is detected"
                                            onChange={e => setGroupRecDraft(e.target.value)}
                                            style={{ resize: 'vertical', padding: '5px 7px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-primary)', fontSize: '0.72rem' }}
                                        />
                                    </div>
                                    {/* Static label, not a live dirty/clean indicator — the
                                        debounced autosave above already runs unconditionally
                                        on every change, this just tells the user that's the
                                        case (matches the approved prototype's `.gedit .saved`,
                                        which is the same always-on label, not a tracked
                                        pending/saved state machine). */}
                                    <div className="fg-edit-saved">
                                        <Check size={12} /> Saved automatically
                                    </div>
                                </div>
                            )}

                            <div style={{ padding: '0 8px 8px 20px', fontSize: '0.7rem' }}>
                                {sensorGroups.length === 0 ? (
                                    <div className="fg-empty-line">
                                        No sensors yet
                                        {onAssignSensors && (
                                            <button
                                                type="button"
                                                className="fg-assign-link"
                                                data-assign-group={group.no}
                                                onClick={() => onAssignSensors(group.no)}
                                                aria-label={`Assign sensors to ${group.name}`}
                                            >
                                                Assign sensors →
                                            </button>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        {sensorGroups.map(sg => renderSensorRow(group.no, sg))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}

                {/* This card always renders, same as a real group's. */}
                {notInGroupVisible.visible && (
                    <div
                        className="fg-group-color-slate fg-group-card"
                        style={{ border: '1px dashed var(--border)', borderRadius: '8px', overflow: 'hidden' }}
                    >
                        <div className="fg-row">
                            <span className="fg-group-dot" />
                            <span className="fg-row-name" style={{ color: 'var(--text-secondary)' }}>
                                Not in Group
                            </span>
                            <span className="fg-row-count">
                                {ungroupedModels.length > 0 ? <><b>{ungroupedModels.filter(isDone).length}</b> / {ungroupedModels.length}</> : '0'}
                            </span>
                        </div>
                        <div style={{ padding: '0 8px 8px 20px', fontSize: '0.7rem' }}>
                            {notInGroupVisible.sensorGroups.length === 0 ? (
                                <div style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                    {notInGroupVisible.sensorGroups.map(sg => renderSensorRow(0, sg))}
                                </div>
                            )}
                            <div style={{ marginTop: '4px', fontSize: '0.65rem', color: 'var(--text-faint)', lineHeight: 1.4 }}>
                                Sensors here aren't tied to any failure group — a place for a standalone model.
                            </div>
                        </div>
                    </div>
                )}

            </div>

            {/* Panel footer: create-group + "Build Model ->" together, in the
                same non-scrolling footer. */}
            <div className="fg-footer">
                {showNewGroup ? (
                    <div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                                autoFocus
                                placeholder="New group name"
                                value={newGroupDraft}
                                onChange={e => { setNewGroupDraft(e.target.value); setNewGroupError(''); }}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') commitNewGroup();
                                    if (e.key === 'Escape') { setShowNewGroup(false); setNewGroupDraft(''); setNewGroupError(''); }
                                }}
                                style={{ flex: 1, minWidth: 0, padding: '5px 7px', background: 'var(--input-bg)', border: `1px solid ${newGroupError ? 'var(--danger, #e2555f)' : 'var(--border)'}`, borderRadius: '5px', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                            />
                            <button className="text-btn" disabled={!newGroupDraft.trim()} onClick={commitNewGroup}>Create</button>
                        </div>
                        {newGroupError && <div style={{ fontSize: '0.68rem', color: 'var(--danger, #e2555f)', marginTop: '3px' }}>{newGroupError}</div>}
                    </div>
                ) : (
                    <button
                        onClick={() => setShowNewGroup(true)}
                        className="fg-addbtn"
                    >
                        <Plus size={13} /> Add failure group
                    </button>
                )}

                {/* The only entry to the Build Model window (the Dashboard header
                    has none). With no model to build it stays visible but
                    disabled, the reason as its tooltip. */}
                <button
                    className="fg-build-model-btn"
                    onClick={onOpenBuildModel}
                    disabled={fgModels.length === 0}
                    title={fgModels.length === 0 ? 'No models yet — assign sensors to a failure group first' : undefined}
                >
                    <Play size={12} /> Build Model →
                </button>
            </div>
        </div>
        </SensorMetaContext.Provider>
    );
}

/** The inline "Delete <group>?" row — the same look as the assignment sheet's. */
export function GroupDeleteConfirm({ name, deleted, kept, onCancel, onConfirm }: {
    name: string; deleted: number; kept: number; onCancel: () => void; onConfirm: () => void;
}) {
    return (
        <div className="fg-sheet-confirm" role="alertdialog" aria-label={`Delete ${name}`} data-testid="fg-delete-confirm">
            <span>{groupDeleteText(name, deleted, kept)}</span>
            <button type="button" className="fg-sheet-btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="fg-sheet-btn fg-sheet-btn--danger" onClick={onConfirm}>Delete</button>
        </div>
    );
}
