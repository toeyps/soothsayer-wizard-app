import { useState } from 'react';
import { Plus, Pencil, Trash2, ArrowRight } from 'lucide-react';
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
    /** Opens the dedicated Build Model window for this group. */
    onOpenBuildModel: (groupNo: number) => void;
}

const isDuplicateName = (groups: FailureGroup[], name: string, excludeNo?: number) =>
    groups.some(g => g.no !== excludeNo && g.name.trim().toLowerCase() === name.trim().toLowerCase());

/**
 * Group-centric "preview" view for the Dashboard's Sensor panel — Failure
 * Groups tab. Each card shows the group's name/ID and every model inside it
 * — the model's own name if one was set, otherwise the target sensor's
 * description — so the whole group is scannable at a glance. Complete/
 * Incomplete status is deliberately NOT shown here (only in the Build Model
 * window) per explicit user request. All editing — description,
 * recommendation, sensors, model config — lives exclusively in the
 * dedicated Build Model window opened by clicking a card, so this view
 * never duplicates state that window already owns.
 */
export default function FailureGroupsPanel({
    fgGroups, fgModels, sensorMetadata, getGroupColor,
    onRenameGroup, onDeleteGroup, onCreateEmptyGroup, onOpenBuildModel,
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
    const modelDisplayLabel = (model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? model.ySensor : model.targetSensor;
        const trimmedName = model.name.trim();
        if (trimmedName && trimmedName !== targetTag) return trimmedName;
        if (!targetTag) return 'Untitled model';
        return sensorMetaMap.get(normalizeSensorTag(targetTag))?.description || targetTag;
    };

    // Group 0 ("Not in Group") is a permanent sentinel carried in fgGroups
    // for backward compatibility, but nothing in the Dashboard-native
    // assignment model ever creates a model for it — so there's nothing
    // meaningful to render for it here.
    const realGroups = [...fgGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModels = fgModels.length;

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
                    const groupModels = fgModels.filter(m => m.groupNo === group.no);
                    const color = getGroupColor(group.no);
                    const isEditingName = editingGroupNo === group.no;
                    return (
                        <div
                            key={group.no}
                            className={`fg-group-color-${color} fg-group-card`}
                            onClick={() => { if (!isEditingName) onOpenBuildModel(group.no); }}
                            style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', cursor: isEditingName ? 'default' : 'pointer' }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 8px' }}>
                                <span className="fg-group-dot" />
                                {isEditingName ? (
                                    <div style={{ flex: 1, minWidth: 0 }} onClick={e => e.stopPropagation()}>
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
                                <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '3px' }}>
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
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: '6px' }}>
                                    <span className="fg-open-hint" style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.66rem', color: 'var(--accent-color)' }}>
                                        Click to open Build Model <ArrowRight size={10} />
                                    </span>
                                </div>
                            </div>
                        </div>
                    );
                })}

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
        </div>
    );
}
