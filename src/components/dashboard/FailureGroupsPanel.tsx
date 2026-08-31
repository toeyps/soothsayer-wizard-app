import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Play, X } from 'lucide-react';
import { FailureGroup, FailureModel, ModelKind, SensorMetadata } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

interface FailureGroupsPanelProps {
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    /** Full sensor pool (every CSV column, not just currently-selected/
     *  plotted ones) for the quick-add modal's sensor pickers — same list
     *  Build Model's own form uses. */
    sensors: string[];
    sensorMetadata: SensorMetadata[] | null;
    getGroupColor: (groupNo: number) => string;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    onCreateEmptyGroup: (name: string) => void;
    /** Creates a model with just enough to exist (name, kind, its
     *  kind-appropriate sensor(s), and which Failure Group(s) it belongs
     *  to — checkboxes, since one model can belong to several at once)
     *  directly from this panel, without opening Build Model first — the
     *  "quick add" flow. Everything else (category, predictors, cluster
     *  ranges, …) is still only editable from Build Model afterward; the
     *  model shows as Incomplete until then, same as any other
     *  freshly-created model. */
    onQuickAddModel: (groupNos: number[], name: string, kind: ModelKind, target: string, xSensor: string, ySensor: string) => void;
    /** Opens the (singleton) Build Model window, which starts on its
     *  overview page (all groups/models, groupable by Failure Group or
     *  Component) — the sole entry point into building models now; cards
     *  themselves no longer open anything on click. */
    onOpenBuildModel: () => void;
}

// Same per-kind colours as BuildModelWindow.tsx's own KIND_ACCENT (and, via
// that, the row badge's .model-kind-icon--* classes in App.css) — duplicated
// rather than imported since this panel and BuildModelWindow don't share a
// components module. Keeps the quick-add modal's kind picker visually
// consistent with the one in Build Model's own form.
const KIND_ACCENT: Record<ModelKind, string> = {
    individual: 'var(--accent-color)',
    relationship: 'var(--warn)',
    clustering: 'var(--kind-clu)',
};
const KIND_ACCENT_MUTED: Record<ModelKind, string> = {
    individual: 'var(--accent-muted)',
    relationship: 'var(--warn-muted)',
    clustering: 'var(--kind-clu-muted)',
};
const KIND_LABELS: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

const isDuplicateName = (groups: FailureGroup[], name: string, excludeNo?: number) =>
    groups.some(g => g.no !== excludeNo && g.name.trim().toLowerCase() === name.trim().toLowerCase());

/**
 * Group-centric "preview" view for the Dashboard's Sensor panel — Failure
 * Groups tab. Each card shows the group's name/ID and every model inside it
 * — the model's own name if one was set, otherwise the target sensor's
 * description — so the whole group is scannable at a glance. Complete/
 * Incomplete status is deliberately NOT shown here (only in the Build Model
 * window) per explicit user request. Cards themselves stay read-only, no
 * click-to-open — the "Build Model" button at the bottom of the panel
 * remains the way into full editing (description, recommendation, sensors,
 * category, predictors, cluster ranges — everything past what quick-add
 * below covers).
 *
 * One exception: each card's own "+ Add model" quick-adds a bare-minimum
 * model (name, kind, target sensor(s)) right here, right after creating the
 * group it belongs to — added per explicit user request so the "create a
 * group, then add its first model" flow doesn't require leaving Dashboard.
 * Deliberately minimal (not the full Build Model form) to avoid growing
 * this already-cramped sidebar panel — everything else about the model is
 * still only editable from Build Model afterward.
 */
export default function FailureGroupsPanel({
    fgGroups, fgModels, sensors, sensorMetadata, getGroupColor,
    onRenameGroup, onDeleteGroup, onCreateEmptyGroup, onQuickAddModel, onOpenBuildModel,
}: FailureGroupsPanelProps) {
    const [editingGroupNo, setEditingGroupNo] = useState<number | null>(null);
    const [editGroupDraft, setEditGroupDraft] = useState('');
    const [editGroupError, setEditGroupError] = useState('');
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [newGroupDraft, setNewGroupDraft] = useState('');
    const [newGroupError, setNewGroupError] = useState('');

    // Quick-add-model modal — which group it's open for (null = closed)
    // plus its own draft-form state. One modal instance reused across
    // every card's "+ Add model" trigger rather than per-card state.
    //
    // 2026-08-25: briefly had a "Failure groups" checkbox here too (a
    // model can belong to several groups at once) — reverted per direct
    // user feedback ("we already picked the failure group [by clicking
    // that card's button] — this page is for picking the model, don't
    // ask again"). The group is already fully determined by which card's
    // button opened the modal; asking again here was pure redundancy.
    // Multi-group membership is still fully supported — it's just edited
    // from Build Model's own form afterward (see BuildModelWindow.tsx),
    // which shows the checkbox only while EDITING an existing model, for
    // the same reason: adding one is always from a specific group's own
    // button, no context to re-ask about.
    const [addModelForGroupNo, setAddModelForGroupNo] = useState<number | null>(null);
    const [draftModelName, setDraftModelName] = useState('');
    const [draftModelKind, setDraftModelKind] = useState<ModelKind | null>(null);
    const [draftModelTarget, setDraftModelTarget] = useState('');
    const [draftModelX, setDraftModelX] = useState('');
    const [draftModelY, setDraftModelY] = useState('');

    // Sensors already "in" a group — a real group's are the ones with an
    // existing individual model whose groupNos include it (same rule
    // SensorSelection.tsx uses to render membership); "Not in Group" (0)
    // has no such pre-selection step, so it gets the full sensor list.
    // Shared by the add-mode sensor restriction and the single-candidate
    // auto-fill below.
    const sensorsForGroup = (groupNo: number): string[] =>
        groupNo === 0 ? sensors : sensors.filter(s => fgModels.some(m => m.kind === 'individual' && m.groupNos.includes(groupNo) && m.targetSensor === s));

    const openAddModel = (groupNo: number) => {
        setAddModelForGroupNo(groupNo);
        // 2026-08-31: if exactly one sensor is already in this group, the
        // user already chose it by toggling it into the FG from the
        // Sensor tab — pre-fill Target immediately instead of making them
        // pick it again from a 1-option dropdown. 2+ sensors still need an
        // explicit pick; group 0 has no natural single candidate to infer.
        // Clustering's X/Y stay manual regardless — confirmed with the
        // user rather than guessed.
        if (groupNo !== 0) {
            const candidates = sensorsForGroup(groupNo);
            if (candidates.length === 1) setDraftModelTarget(candidates[0]);
        }
    };

    const closeAddModel = () => {
        setAddModelForGroupNo(null);
        setDraftModelName('');
        setDraftModelKind(null);
        setDraftModelTarget('');
        setDraftModelX('');
        setDraftModelY('');
    };

    // 2026-08-31: Target/X/Y choices are limited to sensors already
    // toggled into this group (Sensor tab) — a sensor "is in" a group
    // because it has an individual-kind model whose groupNos include that
    // group, same rule SensorSelection.tsx uses to render membership.
    // Prevents picking some unrelated sensor that was never added here.
    //
    // "Not in Group" (0) is exempt — unlike a real group, there's no
    // "toggle sensors in first" step for it (nobody deliberately adds a
    // sensor to the catch-all bucket before building its model), so
    // restricting it the same way just blocked every model there with a
    // false "no sensors yet" — reported by the user immediately after
    // testing. Full sensor list for 0, confirmed via AskUserQuestion.
    const groupSensors = addModelForGroupNo === null ? [] : sensorsForGroup(addModelForGroupNo);

    const addModelValid = draftModelName.trim() !== '' && draftModelKind !== null && (
        draftModelKind === 'clustering' ? draftModelX !== '' && draftModelY !== '' : draftModelTarget !== ''
    );

    const commitAddModel = () => {
        if (!addModelValid || !draftModelKind || addModelForGroupNo === null) return;
        onQuickAddModel([addModelForGroupNo], draftModelName.trim(), draftModelKind, draftModelTarget, draftModelX, draftModelY);
        closeAddModel();
    };

    useEffect(() => {
        if (addModelForGroupNo === null) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAddModel(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addModelForGroupNo]);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    // Model name if the user set one; otherwise the target sensor's
    // description (clustering's "target" is its Y sensor, same convention
    // as component derivation elsewhere); falls back to the raw tag, then a
    // generic placeholder for a brand-new model with no sensor picked yet.
    //
    // A name that's identical to the target tag itself doesn't count as "the
    // user set one" — legacy workspaces migrated from before this redesign
    // default a model's name to its sensor tag when no concept-sensor label
    // existed (see workspaceManager.ts's migration shim), so without this
    // check every migrated model would permanently show its raw tag here
    // instead of ever falling through to the sensor's description.
    //
    // 2026-08-31: the tag itself is now always appended in parens when the
    // target sensor is known — Build Model's own overview always shows the
    // raw tag alongside the name/description ("Target: description (tag)"
    // on its own line), and this panel showed description/name ALONE with
    // no tag at all, which the user flagged as an inconsistency once every
    // group listed the exact same sensor description (several models named
    // after the same sensor were impossible to tell apart at a glance).
    const modelDisplayLabel = (model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? model.ySensor : model.targetSensor;
        const trimmedName = model.name.trim();
        if (!targetTag) return trimmedName || 'Untitled model';
        const label = (trimmedName && trimmedName !== targetTag) ? trimmedName : sensorMetaMap.get(normalizeSensorTag(targetTag))?.description;
        return label ? `${label} (${targetTag})` : targetTag;
    };

    const realGroups = [...fgGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModels = fgModels.length;
    // Group 0 ("Not in Group") is a permanent sentinel carried in fgGroups
    // for models built against a sensor that isn't part of any failure
    // mode. Rendered as its own card, but only once it actually holds a
    // model — an empty "Not in Group" card would just be clutter for the
    // (common) case where nobody's used it.
    const ungroupedModels = fgModels.filter(m => m.groupNos.includes(0));

    const commitGroupRename = () => {
        if (editingGroupNo === null) return;
        const trimmed = editGroupDraft.trim();
        if (!trimmed) { setEditingGroupNo(null); return; }
        if (isDuplicateName(realGroups, trimmed, editingGroupNo)) {
            setEditGroupError(`A failure group named "${trimmed}" already exists`);
            return;
        }
        onRenameGroup(editingGroupNo, trimmed);
        setEditingGroupNo(null);
        setEditGroupError('');
    };

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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                <span><b style={{ color: 'var(--text-primary)' }}>{totalModels}</b> models</span>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span><b style={{ color: 'var(--text-primary)' }}>{realGroups.length}</b> groups</span>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {realGroups.map(group => {
                    const groupModels = fgModels.filter(m => m.groupNos.includes(group.no));
                    const color = getGroupColor(group.no);
                    const isEditingName = editingGroupNo === group.no;
                    return (
                        <div
                            key={group.no}
                            className={`fg-group-color-${color} fg-group-card`}
                            style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 8px' }}>
                                <span className="fg-group-dot" />
                                {isEditingName ? (
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <input
                                            autoFocus
                                            value={editGroupDraft}
                                            onChange={e => { setEditGroupDraft(e.target.value); setEditGroupError(''); }}
                                            onKeyDown={e => { if (e.key === 'Enter') commitGroupRename(); if (e.key === 'Escape') { setEditingGroupNo(null); setEditGroupError(''); } }}
                                            onBlur={commitGroupRename}
                                            style={{ width: '100%', padding: '2px 5px', background: 'var(--input-bg)', border: `1px solid ${editGroupError ? 'var(--danger, #e2555f)' : 'var(--border)'}`, borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.78rem' }}
                                        />
                                        {editGroupError && <div style={{ fontSize: '0.65rem', color: 'var(--danger, #e2555f)', marginTop: '2px' }}>{editGroupError}</div>}
                                    </div>
                                ) : (
                                    <span style={{ flex: 1, fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {group.name}
                                    </span>
                                )}
                                <span style={{ fontSize: '0.66rem', fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>FG-{group.no}</span>
                                <div style={{ display: 'flex', gap: '3px' }}>
                                    <button className="fg-icon-btn fg-icon-btn-edit" title="Rename group" onClick={() => { setEditingGroupNo(group.no); setEditGroupDraft(group.name); setEditGroupError(''); }}>
                                        <Pencil size={11} />
                                    </button>
                                    <button
                                        className="fg-icon-btn fg-icon-btn-danger"
                                        title="Delete group"
                                        onClick={() => { if (confirm(`Delete group "${group.name}"? Every model in it is removed too.`)) onDeleteGroup(group.no); }}
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                            </div>

                            <div style={{ padding: '0 8px 8px 20px', fontSize: '0.7rem' }}>
                                {groupModels.length === 0 ? (
                                    <div style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        {groupModels.map(model => (
                                            <div key={model.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                                {modelDisplayLabel(model)}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <button
                                    onClick={() => openAddModel(group.no)}
                                    style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', padding: '4px 0', background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.68rem', cursor: 'pointer' }}
                                >
                                    <Plus size={11} /> Add model
                                </button>
                            </div>
                        </div>
                    );
                })}

                {/* 2026-08-31: this card now always renders, same as a real
                    group's — it used to render only once it already held a
                    model, which meant there was never a way to add the
                    FIRST one (no "+ Add model" button existed here at all).
                    Reported by the user after testing: "not in group ทำไม
                    ไม่สามารถ add model ได้". */}
                <div
                    className="fg-group-color-slate fg-group-card"
                    style={{ border: '1px dashed var(--border)', borderRadius: '8px', overflow: 'hidden' }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 8px' }}>
                        <span className="fg-group-dot" />
                        <span style={{ flex: 1, fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                            Not in Group
                        </span>
                        <span style={{ fontSize: '0.66rem', fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
                            {ungroupedModels.length} model{ungroupedModels.length === 1 ? '' : 's'}
                        </span>
                    </div>
                    <div style={{ padding: '0 8px 8px 20px', fontSize: '0.7rem' }}>
                        {ungroupedModels.length === 0 ? (
                            <div style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                {ungroupedModels.map(model => (
                                    <div key={model.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                        {modelDisplayLabel(model)}
                                    </div>
                                ))}
                            </div>
                        )}
                        <div style={{ marginTop: '4px', fontSize: '0.65rem', color: 'var(--text-faint)', lineHeight: 1.4 }}>
                            Sensors here aren't tied to any failure group — a place for a standalone model.
                        </div>
                        <button
                            onClick={() => openAddModel(0)}
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', padding: '4px 0', background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.68rem', cursor: 'pointer' }}
                        >
                            <Plus size={11} /> Add model
                        </button>
                    </div>
                </div>

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
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '7px 0', borderRadius: '8px', border: '1px dashed var(--border)', background: 'none', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: 'pointer' }}
                    >
                        <Plus size={13} /> Add failure group
                    </button>
                )}

                {realGroups.length === 0 && !showNewGroup && (
                    <div className="no-results">No failure groups yet</div>
                )}
            </div>

            <div style={{ padding: '8px', borderTop: '1px solid var(--border)' }}>
                <button
                    className="fg-build-model-btn"
                    onClick={onOpenBuildModel}
                >
                    <Play size={12} /> Build Model
                </button>
            </div>

            {addModelForGroupNo !== null && (
                <div className="quick-add-model-backdrop" onClick={closeAddModel}>
                    <div className="quick-add-model-card" onClick={e => e.stopPropagation()}>
                        <div className="quick-add-model-header">
                            <div>
                                <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Add model</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    {addModelForGroupNo === 0 ? 'Not in Group' : (fgGroups.find(g => g.no === addModelForGroupNo)?.name ?? `FG-${addModelForGroupNo}`)}
                                </div>
                            </div>
                            <button className="fg-icon-btn" title="Close" onClick={closeAddModel}><X size={14} /></button>
                        </div>

                        <div className="quick-add-model-body">
                            <div className="fg-inspector-field">
                                <div className="fg-inspector-field-label-row"><label>Model name</label></div>
                                <input
                                    autoFocus
                                    className="fg-inspector-input"
                                    placeholder="e.g. Bearing vibration model"
                                    value={draftModelName}
                                    onChange={e => setDraftModelName(e.target.value)}
                                />
                            </div>

                            {groupSensors.length === 0 ? (
                                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 10px', lineHeight: 1.5 }}>
                                    This group has no sensors yet — add sensors to it from the Sensor tab first.
                                </div>
                            ) : (
                            <>
                            <div className="fg-inspector-field">
                                <div className="fg-inspector-field-label-row"><label>Model kind</label></div>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    {(['individual', 'relationship', 'clustering'] as ModelKind[]).map(k => (
                                        <button
                                            key={k}
                                            onClick={() => setDraftModelKind(k)}
                                            style={{
                                                flex: 1, padding: '6px 4px', borderRadius: '6px', fontSize: '0.72rem', cursor: 'pointer',
                                                border: `1px solid ${draftModelKind === k ? KIND_ACCENT[k] : 'var(--border)'}`,
                                                background: draftModelKind === k ? KIND_ACCENT_MUTED[k] : 'none',
                                                color: draftModelKind === k ? KIND_ACCENT[k] : 'var(--text-secondary)',
                                                fontWeight: draftModelKind === k ? 600 : 400,
                                            }}
                                        >
                                            {KIND_LABELS[k]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {draftModelKind === 'clustering' ? (
                                <>
                                    <div className="fg-inspector-field">
                                        <div className="fg-inspector-field-label-row"><label>X sensor</label></div>
                                        <select className="fg-inspector-input" value={draftModelX} onChange={e => setDraftModelX(e.target.value)}>
                                            <option value="">Select a sensor…</option>
                                            {groupSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </div>
                                    <div className="fg-inspector-field">
                                        <div className="fg-inspector-field-label-row"><label>Y sensor</label></div>
                                        <select className="fg-inspector-input" value={draftModelY} onChange={e => setDraftModelY(e.target.value)}>
                                            <option value="">Select a sensor…</option>
                                            {groupSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </div>
                                </>
                            ) : (
                                <div className="fg-inspector-field">
                                    <div className="fg-inspector-field-label-row"><label>Target sensor</label></div>
                                    <select className="fg-inspector-input" value={draftModelTarget} onChange={e => setDraftModelTarget(e.target.value)} disabled={draftModelKind === null}>
                                        <option value="">Select a sensor…</option>
                                        {groupSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                            )}

                            <div style={{ fontSize: '0.68rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
                                Category, predictors, and other detail can be added later from Build Model.
                            </div>
                            </>
                            )}
                        </div>

                        <div className="quick-add-model-footer">
                            <button className="text-btn" onClick={closeAddModel}>Cancel</button>
                            <button className="fg-build-model-btn" disabled={!addModelValid} onClick={commitAddModel}>Create model</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
