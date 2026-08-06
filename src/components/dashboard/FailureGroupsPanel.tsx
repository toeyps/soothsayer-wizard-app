import { useState } from 'react';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Play, Search } from 'lucide-react';
import { FailureGroup, FailureSensorRow, SensorMetadata } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

type EditableRowField = 'mappedSensorTag' | 'conceptSensor' | 'modelType' | 'modelNotes' | 'status';

interface FailureGroupsPanelProps {
    allSensors: string[];
    sensorMetadata: SensorMetadata[] | null;
    fgGroups: FailureGroup[];
    fgRows: FailureSensorRow[];
    getGroupColor: (groupNo: number) => string;
    onToggleGroupCollapse: (groupNo: number) => void;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    onCreateEmptyGroup: (name: string) => void;
    /** Creates a blank (no sensor tag yet) row in the group and returns its
     *  id, so the caller can immediately expand it into the tag picker. */
    onAddBlankRow: (groupNo: number) => string;
    onUpdateRow: (rowId: string, field: EditableRowField, value: string | boolean) => void;
    onRemoveRow: (rowId: string) => void;
    onBuildModel: (row: FailureSensorRow) => void;
}

/**
 * Group-centric "manage" view for the Dashboard's Sensor panel — Failure
 * Groups tab. Companion to SensorSelection.tsx's own per-sensor quick-assign
 * (FolderPlus icon), which this does NOT replace — that one is for "I'm
 * looking at a sensor, put it in a group"; this one is for "I'm looking at a
 * group, configure what's in it."
 */
export default function FailureGroupsPanel({
    allSensors, sensorMetadata, fgGroups, fgRows, getGroupColor,
    onToggleGroupCollapse, onRenameGroup, onDeleteGroup, onCreateEmptyGroup,
    onAddBlankRow, onUpdateRow, onRemoveRow, onBuildModel,
}: FailureGroupsPanelProps) {
    // One row's inline editor open at a time — same convention as the color
    // picker / axis editor / alarm checkboxes elsewhere in this panel family.
    const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
    const [tagSearch, setTagSearch] = useState('');
    const [editingGroupNo, setEditingGroupNo] = useState<number | null>(null);
    const [editGroupDraft, setEditGroupDraft] = useState('');
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [newGroupDraft, setNewGroupDraft] = useState('');

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getDesc = (tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description ?? '';

    // Group 0 ("Not in Group") is a permanent sentinel carried in fgGroups
    // for backward compatibility, but nothing in the Dashboard-native
    // assignment model (toggleSensorGroup / createGroupForSensor) ever
    // creates a row for it — a sensor simply has no row until it's put in a
    // real group. So there's nothing meaningful to render for it here.
    const realGroups = [...fgGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalSensors = fgRows.length;
    const readyCount = fgRows.filter(r => r.status).length;
    const completionPct = totalSensors > 0 ? Math.round((readyCount / totalSensors) * 100) : 0;

    const toggleRow = (rowId: string) => {
        setExpandedRowId(prev => (prev === rowId ? null : rowId));
        setTagSearch('');
    };

    const handleAddSensor = (groupNo: number) => {
        const id = onAddBlankRow(groupNo);
        setExpandedRowId(id);
        setTagSearch('');
    };

    const selectTagForRow = (row: FailureSensorRow, tag: string) => {
        const groupRows = fgRows.filter(r => r.groupNo === row.groupNo && r.id !== row.id);
        if (groupRows.some(r => r.mappedSensorTag.toLowerCase() === tag.toLowerCase())) {
            alert(`Sensor "${tag}" is already in this group.`);
            return;
        }
        onUpdateRow(row.id, 'mappedSensorTag', tag);
        setTagSearch('');
    };

    const filteredTagOptions = allSensors.filter(s => {
        if (!tagSearch) return true;
        const q = tagSearch.toLowerCase();
        return s.toLowerCase().includes(q) || getDesc(s).toLowerCase().includes(q);
    });

    const commitGroupRename = () => {
        if (editingGroupNo === null) return;
        onRenameGroup(editingGroupNo, editGroupDraft);
        setEditingGroupNo(null);
    };

    const commitNewGroup = () => {
        if (!newGroupDraft.trim()) return;
        onCreateEmptyGroup(newGroupDraft);
        setNewGroupDraft('');
        setShowNewGroup(false);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                <span><b style={{ color: 'var(--text-primary)' }}>{totalSensors}</b> sensors</span>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span><b style={{ color: 'var(--text-primary)' }}>{realGroups.length}</b> groups</span>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span><b style={{ color: 'var(--ok)' }}>{completionPct}%</b> complete</span>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {realGroups.map(group => {
                    const groupRows = fgRows.filter(r => r.groupNo === group.no);
                    const color = getGroupColor(group.no);
                    const isEditingName = editingGroupNo === group.no;
                    return (
                        <div key={group.no} className={`fg-group-color-${color}`} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                            <div
                                onClick={() => onToggleGroupCollapse(group.no)}
                                className="fg-group-card-header"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 8px', cursor: 'pointer' }}
                            >
                                {group.isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                                <span className="fg-group-dot" />
                                {isEditingName ? (
                                    <input
                                        autoFocus
                                        value={editGroupDraft}
                                        onClick={e => e.stopPropagation()}
                                        onChange={e => setEditGroupDraft(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') commitGroupRename(); }}
                                        onBlur={commitGroupRename}
                                        style={{ flex: 1, minWidth: 0, padding: '2px 5px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.78rem' }}
                                    />
                                ) : (
                                    <span style={{ flex: 1, fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {group.name}
                                    </span>
                                )}
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{groupRows.length}</span>
                                <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '3px' }}>
                                    <button className="fg-icon-btn fg-icon-btn-add" title="Add sensor" onClick={() => handleAddSensor(group.no)}>
                                        <Plus size={12} />
                                    </button>
                                    <button className="fg-icon-btn fg-icon-btn-edit" title="Rename group" onClick={() => { setEditingGroupNo(group.no); setEditGroupDraft(group.name); }}>
                                        <Pencil size={11} />
                                    </button>
                                    <button
                                        className="fg-icon-btn fg-icon-btn-danger"
                                        title="Delete group"
                                        onClick={() => { if (confirm(`Delete group "${group.name}"? Every sensor in it is removed too.`)) onDeleteGroup(group.no); }}
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                            </div>

                            {!group.isCollapsed && (
                                <div>
                                    {groupRows.length === 0 && (
                                        <div style={{ padding: '8px 10px', fontSize: '0.7rem', color: 'var(--text-faint)' }}>No sensors yet</div>
                                    )}
                                    {groupRows.map(row => {
                                        const expanded = expandedRowId === row.id;
                                        return (
                                            <div key={row.id} style={{ borderTop: '1px solid var(--border)' }}>
                                                <div
                                                    onClick={() => toggleRow(row.id)}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px 6px 22px', cursor: 'pointer' }}
                                                >
                                                    <span style={{ flex: 1, fontSize: '0.75rem', fontFamily: 'var(--mono)', color: row.mappedSensorTag ? 'var(--text-primary)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {row.mappedSensorTag || '— no tag —'}
                                                    </span>
                                                    <button
                                                        className={`fg-status-pill fg-status-pill--${row.status ? 'ok' : 'neutral'}`}
                                                        onClick={e => { e.stopPropagation(); onUpdateRow(row.id, 'status', !row.status); }}
                                                        title="Click to toggle"
                                                        style={{ cursor: 'pointer' }}
                                                    >
                                                        {row.status ? 'Complete' : 'Incomplete'}
                                                    </button>
                                                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                                </div>

                                                {expanded && !row.mappedSensorTag && (
                                                    <div onClick={e => e.stopPropagation()} style={{ padding: '2px 8px 10px 22px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '3px 6px' }}>
                                                            <Search size={11} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                                                            <input
                                                                autoFocus
                                                                placeholder="Search sensor…"
                                                                value={tagSearch}
                                                                onChange={e => setTagSearch(e.target.value)}
                                                                style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.72rem' }}
                                                            />
                                                        </div>
                                                        <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                                                            {filteredTagOptions.slice(0, 30).map(s => (
                                                                <button
                                                                    key={s}
                                                                    className="text-btn"
                                                                    onClick={() => selectTagForRow(row, s)}
                                                                    style={{ textAlign: 'left', padding: '4px 6px', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
                                                                >
                                                                    <span style={{ fontFamily: 'var(--mono)' }}>{s}</span>
                                                                    {getDesc(s) && <span style={{ color: 'var(--text-secondary)', fontSize: '0.65rem' }}>{getDesc(s)}</span>}
                                                                </button>
                                                            ))}
                                                            {filteredTagOptions.length === 0 && (
                                                                <span style={{ fontSize: '0.7rem', color: 'var(--text-faint)', padding: '4px 6px' }}>No sensors found</span>
                                                            )}
                                                        </div>
                                                        <button className="text-btn" onClick={() => onRemoveRow(row.id)} style={{ alignSelf: 'flex-start', fontSize: '0.68rem', color: 'var(--text-faint)' }}>
                                                            Cancel — remove this row
                                                        </button>
                                                    </div>
                                                )}

                                                {expanded && row.mappedSensorTag && (
                                                    <div onClick={e => e.stopPropagation()} style={{ padding: '4px 8px 10px 22px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                        <div className="fg-inspector-field">
                                                            <div className="fg-inspector-field-label-row"><label>Concept sensor</label></div>
                                                            <input className="fg-inspector-input" value={row.conceptSensor} placeholder="e.g. crankcase vibration" onChange={e => onUpdateRow(row.id, 'conceptSensor', e.target.value)} />
                                                        </div>
                                                        <div className="fg-inspector-field">
                                                            <div className="fg-inspector-field-label-row"><label>Model type</label></div>
                                                            <input className="fg-inspector-input" value={row.modelType} placeholder="e.g. I + R" onChange={e => onUpdateRow(row.id, 'modelType', e.target.value)} />
                                                        </div>
                                                        <div className="fg-inspector-field">
                                                            <div className="fg-inspector-field-label-row"><label>Model notes</label></div>
                                                            <textarea className="fg-inspector-textarea" rows={2} value={row.modelNotes} placeholder="Notes about training, features, thresholds…" onChange={e => onUpdateRow(row.id, 'modelNotes', e.target.value)} />
                                                        </div>
                                                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                                            <input type="checkbox" checked={row.status} onChange={e => onUpdateRow(row.id, 'status', e.target.checked)} />
                                                            Complete
                                                        </label>
                                                        <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                                                            <button className="text-btn" onClick={() => onRemoveRow(row.id)} style={{ flex: 1, fontSize: '0.7rem' }}>Remove</button>
                                                            <button className="fg-build-model-btn" style={{ flex: 1 }} onClick={() => onBuildModel(row)}>
                                                                <Play size={11} /> Build model
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}

                {showNewGroup ? (
                    <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                            autoFocus
                            placeholder="New group name"
                            value={newGroupDraft}
                            onChange={e => setNewGroupDraft(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') commitNewGroup();
                                if (e.key === 'Escape') { setShowNewGroup(false); setNewGroupDraft(''); }
                            }}
                            style={{ flex: 1, minWidth: 0, padding: '5px 7px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                        />
                        <button className="text-btn" disabled={!newGroupDraft.trim()} onClick={commitNewGroup}>Create</button>
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
