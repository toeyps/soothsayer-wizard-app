import { useState } from 'react';
import { Plus, Pencil, Trash2, Play } from 'lucide-react';
import { FailureGroup, FailureModel, SensorMetadata } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

interface FailureGroupsPanelProps {
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    sensorMetadata: SensorMetadata[] | null;
    getGroupColor: (groupNo: number) => string;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    onCreateEmptyGroup: (name: string) => void;
    /** Deletes a model record outright — 2026-08-31: model lifecycle (both
     *  creation, via the Sensor tab's per-kind toggle, and deletion, here)
     *  now lives entirely on Dashboard, per explicit user request ("การ add
     *  model หรือลบ model ทำเสร็จทั้งหมดในหน้า dashboard"). Build Model no
     *  longer creates or removes models at all — only edits/trains them. */
    onDeleteModel: (modelId: string) => void;
    /** Opens the (singleton) Build Model window — for editing a model's
     *  detail (category, notes, predictors, cluster ranges, kind, …) and
     *  training it. Cards themselves still don't open anything on click. */
    onOpenBuildModel: () => void;
}

const isDuplicateName = (groups: FailureGroup[], name: string, excludeNo?: number) =>
    groups.some(g => g.no !== excludeNo && g.name.trim().toLowerCase() === name.trim().toLowerCase());

/**
 * Group-centric "preview" view for the Dashboard's Sensor panel — Failure
 * Groups tab. Each card shows the group's name/ID and every model inside it
 * — the model's own name if one was set, otherwise the target sensor's
 * description — so the whole group is scannable at a glance, plus a delete
 * button per model. Complete/Incomplete status is deliberately NOT shown
 * here (only in the Build Model window) per explicit user request.
 *
 * 2026-08-31: model creation and deletion both live entirely on Dashboard
 * now, per explicit user request — this panel handles deletion (a trash
 * icon per model row below); creation happens on the Sensor tab (per-kind
 * toggle on each sensor, see SensorSelection.tsx). Build Model is left
 * with only editing a model's detail and training it, no create/delete at
 * all. This panel briefly had its own "+ Add model" quick-add popup per
 * card (2026-08-25) — removed again once the user clarified they wanted
 * creation forced through one place instead ("เอาปุ่ม add model ออกเลย
 * ผมบังคับให้ add จากหน้า dashboard เท่านั้น" → turned out to mean the
 * Sensor tab, not this panel).
 */
export default function FailureGroupsPanel({
    fgGroups, fgModels, sensorMetadata, getGroupColor,
    onRenameGroup, onDeleteGroup, onCreateEmptyGroup, onDeleteModel, onOpenBuildModel,
}: FailureGroupsPanelProps) {
    const [editingGroupNo, setEditingGroupNo] = useState<number | null>(null);
    const [editGroupDraft, setEditGroupDraft] = useState('');
    const [editGroupError, setEditGroupError] = useState('');
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [newGroupDraft, setNewGroupDraft] = useState('');
    const [newGroupError, setNewGroupError] = useState('');

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

    // 2026-08-31: a trash icon per model row — deleting a model now lives
    // entirely on Dashboard (this panel), per explicit user request. No
    // confirmation dialog, matching this session's "click does the thing"
    // policy for every other destructive action in the app.
    const renderModelRow = (model: FailureModel) => (
        <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
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

    const realGroups = [...fgGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModels = fgModels.length;
    // Group 0 ("Not in Group") is a permanent sentinel carried in fgGroups
    // for models built against a sensor that isn't part of any failure
    // mode. Always rendered as its own card now (2026-08-31 fix — it used
    // to hide until non-empty, which meant there was no entry point to
    // ever get a model into it in the first place).
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
                                        // 2026-08-31: no confirmation dialog anywhere in the app,
                                        // per explicit user request — click delete, it's deleted.
                                        // (Briefly used an async ask() here to fix window.confirm()
                                        // not actually blocking in Tauri's webview; removed again
                                        // once the user clarified they want no confirmation at all,
                                        // system-wide, not just a working one.)
                                        onClick={() => onDeleteGroup(group.no)}
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
                                        {groupModels.map(model => renderModelRow(model))}
                                    </div>
                                )}
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
                                {ungroupedModels.map(model => renderModelRow(model))}
                            </div>
                        )}
                        <div style={{ marginTop: '4px', fontSize: '0.65rem', color: 'var(--text-faint)', lineHeight: 1.4 }}>
                            Sensors here aren't tied to any failure group — a place for a standalone model.
                        </div>
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

        </div>
    );
}
