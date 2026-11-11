import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { groupDeleteText } from './groupDeleteText';
import { Plus, Trash2, Play, ChevronRight, Check, FolderPlus, X } from 'lucide-react';
import { useModalFocus } from '../windows/useModalFocus';
import { FailureGroup, FailureModel, FailureGroupStateSlice, ModelKind, SensorMetadata, SpecialSensorRecipe } from '../../types';
import { SensorInline, SensorLabel, SensorSetProvider, SetPrefixLine } from '../sensor/SensorLabel';
import { useLineCut } from '../../hooks/useNameFit';
import { NAME_TAIL_MAX, displayedName } from '../../utils/sensorNames';
import { SensorMetaContext, sensorHaystack, sensorTitle, useLayeredSensorLookup, useSensorLookup } from '../sensor/sensorInfo';
import { groupDeleteCounts, groupModelsBySensor, type SensorModelGroup } from '../../utils/modelGrouping';
import { MODEL_KIND_LABEL } from '../../utils/modelNames';
import type { RunningConditionFg } from '../../utils/runningCondition';
import { isModelComplete, modelDotState, modelSetPointFlag } from '../../utils/modelStatus';
import { summarizeFailureGroups } from '../../utils/failureGroupSummary';
import { isDuplicateFailureGroupName } from './failureGroupOps';

const KIND_LABEL = MODEL_KIND_LABEL;

interface FailureGroupsPanelProps {
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    sensorMetadata: SensorMetadata[] | null;
    /** Running-condition state (Dashboard's `fgExtra`); with `fgModels` it decides blocked vs trained-and-fresh (see `dotStatusFor`). */
    runningConditionFg: Omit<FailureGroupStateSlice, 'groups' | 'models'>;
    /** Dataset headers (null before load): tells a missing running-condition sensor from an unconfigured one. */
    datasetHeaders: string[] | null;
    /** Special-sensor recipes: a model trained on a changed formula reads out of date. Pass a stable array (signatures are memoised). */
    specialSensorRecipes?: SpecialSensorRecipe[] | null;
    getGroupColor: (groupNo: number) => string;
    /** Saves Name + Description + Recommendation together (the name isn't editable separately). */
    onUpdateGroupDetails: (groupNo: number, name: string, description: string, recommendation: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    onCreateEmptyGroup: (name: string, description: string, recommendation: string) => void;
    /** Deletes a model outright; creation (Sensor tab) and deletion live on Dashboard, Build Model only edits/trains. */
    onDeleteModel: (modelId: string) => void;
    /** Opens the singleton Build Model window; cards themselves open nothing on click. */
    onOpenBuildModel: () => void;
    /** "Assign sensors →" on a group with no sensors: switches the Sensor tab to assign mode for that group. Omitted = no link. */
    onAssignSensors?: (groupNo: number) => void;
}

// The same duplicate rule as the Dashboard's own group writers and Import step 3.
const isDuplicateName = isDuplicateFailureGroupName;

/** Model row text "name (tag)", end-cut; if the sensor has a long name and the line is cut, print the model's own name instead (clustering adds its Y sensor). */
function FgModelText({ model, text }: { model: FailureModel; text: string }) {
    const [ref, cut] = useLineCut(text);
    const lookup = useSensorLookup();
    const named = (model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor) ?? '';
    const longName = named.length > NAME_TAIL_MAX || displayedName(lookup(named)).length > NAME_TAIL_MAX;
    if (!cut || !longName) {
        return (
            <span ref={ref} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                {text}
            </span>
        );
    }
    const key = model.kind === 'clustering' ? model.xSensor : model.targetSensor;
    const target = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
    const name = model.name.trim();
    const own = name && name !== target ? name : '';
    return (
        <span ref={ref} className="fg-model-text" title={text}>
            {own
                ? <span className="fg-model-name">{own}</span>
                : target ? <SensorInline tag={target} size="sm" muted /> : <span className="fg-model-name">{text}</span>}
            {own && model.kind === 'clustering' && model.ySensor && model.ySensor !== key && (
                <span className="fg-model-y" data-testid="fg-model-y"><b>Y</b><SensorInline tag={model.ySensor} size="sm" muted /></span>
            )}
        </span>
    );
}

/** The sensor a sensor line names ('' = a model with no sensor yet). */
const sensorGroupTag = (sg: SensorModelGroup): string => {
    const first = sg.models[0];
    return (first && (first.kind === 'clustering' ? first.xSensor : first.targetSensor)) || '';
};

/** Failure Groups tab of the Sensor panel: a card per group with its models, a delete per model and an "Edit details" toggle. Status dots follow `utils/modelStatus.ts`, shared with BuildModelWindow. Models are created on the Sensor tab; this panel only deletes. */
export default function FailureGroupsPanel({
    fgGroups, fgModels, sensorMetadata, runningConditionFg, datasetHeaders, specialSensorRecipes, getGroupColor,
    onUpdateGroupDetails, onDeleteGroup, onCreateEmptyGroup, onDeleteModel, onOpenBuildModel, onAssignSensors,
}: FailureGroupsPanelProps) {
    // "Edit details" panel (Name + Description + Recommendation), one group expanded at a time.
    const [expandedGroupNo, setExpandedGroupNo] = useState<number | null>(null);
    // Deleting a group deletes the models that are only in it: ask first.
    const [confirmDeleteNo, setConfirmDeleteNo] = useState<number | null>(null);
    const [groupNameDraft, setGroupNameDraft] = useState('');
    const [groupNameError, setGroupNameError] = useState('');
    const [groupDescDraft, setGroupDescDraft] = useState('');
    const [groupRecDraft, setGroupRecDraft] = useState('');
    // Expanded sensor lines, keyed `${groupNo}:${sensorKey}`; the per-model rows live inside the expansion.
    const [expandedSensors, setExpandedSensors] = useState<Set<string>>(new Set());
    const toggleSensor = (id: string) => setExpandedSensors(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const [showNewGroup, setShowNewGroup] = useState(false);
    // Display-only search; does not change which models/groups exist.
    const [fgSearch, setFgSearch] = useState('');

    // Same stacked label as the Sensor tab: this panel's metadata layered on the window's provider.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);

    // `RunningConditionFg` needs `models` (category falls back to it when a model's `category` is null); spread in from `fgModels`.
    const fg: RunningConditionFg = { ...runningConditionFg, models: fgModels };

    // Status comes from `utils/modelStatus.ts` (shared with Build Model); `stale`/`blocked` draw no dot.
    // Gate-blocked reads 'none' even if fresh; set points Rust rejected or left empty read red/yellow via `modelSetPointFlag`.
    const dotStatusFor = (m: FailureModel): 'none' | 'trained' | 'complete' | 'need' | 'bad' => {
        const s = modelDotState(m, fg, datasetHeaders, specialSensorRecipes);
        if (s === 'trained') {
            const flag = modelSetPointFlag(m, fg, datasetHeaders, s, specialSensorRecipes);
            return flag === 'fix' ? 'bad' : flag === 'needed' ? 'need' : 'trained';
        }
        return s === 'complete' ? s : 'none';
    };
    const isDone = (m: FailureModel): boolean => isModelComplete(m, fg, specialSensorRecipes);
    // Label: the model's name if set, else the target sensor's description (clustering: its Y sensor), else the tag, else a placeholder.
    // A name equal to the target tag counts as unset. The tag is appended in parens when known.
    const modelDisplayLabel = (model: FailureModel) => {
        // Clustering's Y stays blank until set in Build Model, so fall back to X to keep the "description (tag)" shape.
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const trimmedName = model.name.trim();
        if (!targetTag) return trimmedName || 'Untitled model';
        const label = (trimmedName && trimmedName !== targetTag) ? trimmedName : sensorLookup(targetTag).description;
        return label ? `${label} (${targetTag})` : targetTag;
    };

    // Per-model trash icon (no confirmation) and an I/R/C `.kind-badge` without a dot; the sensor row shows the dots.
    const renderModelRow = (model: FailureModel) => (
        <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div
                className={`kind-badge kind-badge--${model.kind}`}
                title={KIND_LABEL[model.kind]}
                style={{ width: '16px', height: '16px', borderRadius: '4px', fontSize: '0.56rem', flexShrink: 0 }}
            >
                {model.kind.charAt(0).toUpperCase()}
            </div>
            <FgModelText model={model} text={modelDisplayLabel(model)} />
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

    // One collapsible line per sensor per group: a chip per existing kind in the header, model rows with delete inside. Category is set in Build Model.
    // Do not rename `.f4-kb-dot`: `BuildModelWorkbenchStatusDotCrossWindow.integration.test.tsx` reads it by regex and would silently read "none".
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
                            ? <SensorLabel tag={keyTag} info={info} wrap="always" />
                            : <span className="fg-srow-plain">{label}</span>}
                    </button>
                    {kinds.map(k => {
                        // One model per (sensor, kind) workspace-wide and `sg.models` is scoped to this FG, so at most one match.
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
                    <div className="fg-srow-body" style={{ display: 'flex', flexDirection: 'column', gap: '3px', margin: '4px 0 2px 15px', paddingLeft: '8px', borderLeft: '1px solid var(--border)' }}>
                        {sg.models.map(m => renderModelRow(m))}
                    </div>
                )}
            </div>
        );
    };

    const realGroups = [...fgGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    // Summary line, memoised so chart hover/pan doesn't re-walk models; `x` uses `isModelComplete`.
    const summary = useMemo(
        () => summarizeFailureGroups(fgGroups, fgModels, { ...runningConditionFg, models: fgModels }),
        [fgGroups, fgModels, runningConditionFg],
    );
    // Real groups with no model yet get "Assign sensors →"; while one exists the landing callout points at that step.
    const emptyGroupNos = useMemo(() => {
        const used = new Set<number>();
        for (const m of fgModels) for (const no of m.groupNos) used.add(no);
        return new Set(fgGroups.filter(g => g.no !== 0 && !used.has(g.no)).map(g => g.no));
    }, [fgGroups, fgModels]);
    // Group 0 ("Not in Group") is a permanent sentinel for sensors in no failure mode; always rendered as its own card.
    const ungroupedModels = fgModels.filter(m => m.groupNos.includes(0));

    // Name match keeps all of a group's lines, otherwise only description/tag matches; a group left empty is hidden.
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

    // Debounced save (250ms); `toggleGroupDetails` seeds drafts to current values on expand, so it no-ops until the user changes something.
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

    // "Not in Group" uses the same search visibility rule as a real group; computed here since it isn't in the `realGroups.map()`.
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
                    {/* No dot on purpose: a never-trained badge shows none (`renderSensorRow` gates the dot on `dot !== 'none'`). */}
                    <span>Not trained</span>
                    <span><i className="fg-legend-dot fg-legend-dot--trained" />Trained</span>
                    <span><i className="fg-legend-dot fg-legend-dot--complete" />Complete</span>
                </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {/* Landing callout for projects with no groups or an empty group; refer to the lucide button by name, never an emoji. */}
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
                                    {/* Static label, not a live dirty indicator: the debounced autosave always runs. */}
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
                                        <SensorSetProvider tags={sensorGroups.map(sensorGroupTag)} drop>
                                            <SetPrefixLine className="fg-card-prefix" testid="fg-card-prefix" />
                                            {sensorGroups.map(sg => renderSensorRow(group.no, sg))}
                                        </SensorSetProvider>
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
                                    <SensorSetProvider tags={notInGroupVisible.sensorGroups.map(sensorGroupTag)} drop>
                                        <SetPrefixLine className="fg-card-prefix" testid="fg-card-prefix" />
                                        {notInGroupVisible.sensorGroups.map(sg => renderSensorRow(0, sg))}
                                    </SensorSetProvider>
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
                <button
                    onClick={() => setShowNewGroup(true)}
                    className="fg-addbtn"
                >
                    <Plus size={13} /> Add failure group
                </button>
                {showNewGroup && (
                    <NewFailureGroupModal
                        groups={realGroups}
                        onCancel={() => setShowNewGroup(false)}
                        onCreate={(name, desc, rec) => { onCreateEmptyGroup(name, desc, rec); setShowNewGroup(false); }}
                    />
                )}

                {/* Only entry to the Build Model window; with no model to build it stays visible but disabled, reason as tooltip. */}
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

const FIELD_LABEL: CSSProperties = { fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' };
const FIELD_INPUT: CSSProperties = { padding: '6px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-primary)', fontSize: '0.78rem' };

/** "Add failure group" popup: Name (required, unique) + Description + Recommendation. */
export function NewFailureGroupModal({ groups, onCreate, onCancel }: {
    groups: FailureGroup[];
    onCreate: (name: string, description: string, recommendation: string) => void;
    onCancel: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, true);
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');
    const [rec, setRec] = useState('');
    const [error, setError] = useState('');
    const onCancelRef = useRef(onCancel);
    onCancelRef.current = onCancel;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            e.stopPropagation();
            onCancelRef.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    const commit = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        if (isDuplicateName(groups, trimmed)) {
            setError(`A failure group named "${trimmed}" already exists`);
            return;
        }
        onCreate(trimmed, desc, rec);
    };

    return (
        <div className="bmw-modal-backdrop" role="presentation" onMouseDown={onCancel}>
            <div
                ref={ref}
                tabIndex={-1}
                className="bmw-modal tq-modal"
                style={{ width: 'min(460px, 100%)' }}
                role="dialog"
                aria-modal="true"
                aria-label="New failure group"
                onMouseDown={e => e.stopPropagation()}
            >
                <div className="tq-mh">
                    <div>
                        New failure group
                        <small>Description and recommendation can be changed later with Edit details.</small>
                    </div>
                    <button type="button" className="bmw-modal-x" aria-label="Close" onClick={onCancel}><X size={16} /></button>
                </div>
                <div className="tq-mb" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={FIELD_LABEL}>Name</span>
                        <input
                            autoFocus
                            placeholder="New group name"
                            value={name}
                            onChange={e => { setName(e.target.value); setError(''); }}
                            onKeyDown={e => { if (e.key === 'Enter') commit(); }}
                            style={{ ...FIELD_INPUT, fontWeight: 600, borderColor: error ? 'var(--danger, #e2555f)' : 'var(--border)' }}
                        />
                        {error && <span style={{ fontSize: '0.68rem', color: 'var(--danger, #e2555f)' }}>{error}</span>}
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={FIELD_LABEL}>Description</span>
                        <textarea rows={3} value={desc} placeholder="What failure mode does this group track?" onChange={e => setDesc(e.target.value)} style={{ ...FIELD_INPUT, resize: 'vertical' }} />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={FIELD_LABEL}>Recommendation</span>
                        <textarea rows={3} value={rec} placeholder="Recommended action when this failure is detected" onChange={e => setRec(e.target.value)} style={{ ...FIELD_INPUT, resize: 'vertical' }} />
                    </label>
                </div>
                <div className="tq-mf" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="rcx-btn" onClick={onCancel}>Cancel</button>
                    <button type="button" className="rcx-btn rcx-btn--pri" disabled={!name.trim()} onClick={commit}>Create</button>
                </div>
            </div>
        </div>
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
