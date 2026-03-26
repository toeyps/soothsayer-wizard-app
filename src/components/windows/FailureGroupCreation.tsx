import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, emit } from "@tauri-apps/api/event";
import { CsvMetadata, SensorMetadata } from "../../types";
import { Upload, Download, Save, Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle, X, Edit3, FolderPlus, BarChart3 } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────

interface FailureGroupData {
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
}

interface FailureGroup {
    no: number;
    name: string;
    isCollapsed: boolean;
}

interface SensorRow {
    id: string;
    groupNo: number;
    conceptSensor: string;
    mappedSensorTag: string;
    mappedSensorName: string;
    modelType: string;
    modelNotes: string;
    additionalNotes: string;
    status: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

let _rowId = 0;
const nextId = () => `row-${++_rowId}`;

function getSensorName(tag: string, meta: SensorMetadata[] | null): string {
    if (!meta || !tag) return "";
    const found = meta.find(m => m.tag.toLowerCase() === tag.toLowerCase());
    return found ? found.description : tag;
}

// ── Component ──────────────────────────────────────────────────────────

export default function FailureGroupCreation() {
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [metadata, setMetadata] = useState<CsvMetadata | null>(null);
    const [loading, setLoading] = useState(true);

    const [groups, setGroups] = useState<FailureGroup[]>([
        { no: 0, name: "Not in Group", isCollapsed: false }
    ]);
    const [rows, setRows] = useState<SensorRow[]>([]);
    const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

    const [showNewGroupDialog, setShowNewGroupDialog] = useState(false);
    const [newGroupName, setNewGroupName] = useState("");
    const newGroupInputRef = useRef<HTMLInputElement>(null);

    const [editingGroupNo, setEditingGroupNo] = useState<number | null>(null);
    const [editingGroupName, setEditingGroupName] = useState("");

    const [dropdownRowId, setDropdownRowId] = useState<string | null>(null);
    const [dropdownSearch, setDropdownSearch] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);

    const [showModelPanel, setShowModelPanel] = useState(false);
    const [isBuildModelOpen, setIsBuildModelOpen] = useState(false);

    // ── Setup ────────────────────────────────────────────────────

    useEffect(() => {
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        let unlistenData: (() => void) | undefined;
        const setup = async () => {
            unlistenData = await listen<FailureGroupData>('failure-group-data', (event) => {
                const d = event.payload;
                setAllSensors(d.sensorHeaders);
                setSensorMetadata(d.sensorMetadata);
                setMetadata(d.metadata);
                setLoading(false);
            });
            await emit('request-failure-group-data');
        };
        setup();
        return () => { if (unlistenData) unlistenData(); };
    }, []);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownRowId(null);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    useEffect(() => {
        if (showNewGroupDialog && newGroupInputRef.current) newGroupInputRef.current.focus();
    }, [showNewGroupDialog]);

    // ── Build Model ──────────────────────────────────────────────

    const pendingModelDataRef = useRef<{ targetSensor: string; predictorSensors: string[] } | null>(null);

    useEffect(() => {
        let unlistenReq: (() => void) | undefined;
        const setupModelListener = async () => {
            unlistenReq = await listen('request-predictive-data', async () => {
                if (pendingModelDataRef.current && metadata) {
                    await emit('predictive-model-data', {
                        targetSensor: pendingModelDataRef.current.targetSensor,
                        predictorSensors: pendingModelDataRef.current.predictorSensors,
                        sensorHeaders: allSensors,
                        sensorMetadata,
                        metadata,
                    });
                }
            });
        };
        setupModelListener();
        return () => { if (unlistenReq) unlistenReq(); };
    }, [allSensors, sensorMetadata, metadata]);

    const handleBuildModel = async (row: SensorRow) => {
        if (!row.mappedSensorTag) return;
        pendingModelDataRef.current = { targetSensor: row.mappedSensorTag, predictorSensors: [] };
        try {
            const screenW = window.screen.width;
            const screenH = window.screen.height;
            const webview = new WebviewWindow('predictive-model', {
                url: '/?window=predictive-model',
                title: `Predictive Model — ${row.mappedSensorTag}`,
                width: Math.round(screenW * 0.75),
                height: Math.round(screenH * 0.85),
                center: true,
                decorations: false,
            });
            webview.once('tauri://created', () => {
                setIsBuildModelOpen(true);
            });
            webview.once('tauri://error', (e) => {
                console.error('Failed to open predictive model window:', e);
            });
            // Listen for custom close event from BuildModel window
            const unlistenClose = await listen('predictive-model-closed', () => {
                setIsBuildModelOpen(false);
                unlistenClose();
            });
        } catch (err) {
            console.error('Error opening predictive model window:', err);
        }
    };

    // ── Group Actions ─────────────────────────────────────────────

    const handleClose = async () => {
        if (isBuildModelOpen) {
            // Focus the BuildModel window and trigger a shake animation
            try {
                const bmWindow = await WebviewWindow.getByLabel('predictive-model');
                if (bmWindow) await bmWindow.setFocus();
            } catch (_) { /* ignore */ }
            await emit('predictive-model-shake');
            return;
        }
        await getCurrentWindow().close();
    };

    const createGroup = () => {
        const name = newGroupName.trim() || `Group ${groups.length}`;
        const maxNo = Math.max(...groups.map(g => g.no), 0);
        setGroups(prev => [...prev, { no: maxNo + 1, name, isCollapsed: false }]);
        setNewGroupName("");
        setShowNewGroupDialog(false);
    };

    const removeGroup = (groupNo: number) => {
        if (groupNo === 0) return;
        setRows(prev => prev.filter(r => r.groupNo !== groupNo));
        setGroups(prev => prev.filter(g => g.no !== groupNo));
    };

    const toggleGroupCollapse = (groupNo: number) => {
        setGroups(prev => prev.map(g => g.no === groupNo ? { ...g, isCollapsed: !g.isCollapsed } : g));
    };

    const startEditingGroupName = (groupNo: number) => {
        const group = groups.find(g => g.no === groupNo);
        if (!group || groupNo === 0) return;
        setEditingGroupNo(groupNo);
        setEditingGroupName(group.name);
    };

    const finishEditingGroupName = () => {
        if (editingGroupNo === null) return;
        const name = editingGroupName.trim();
        if (name) setGroups(prev => prev.map(g => g.no === editingGroupNo ? { ...g, name } : g));
        setEditingGroupNo(null);
        setEditingGroupName("");
    };

    // ── Row Actions ──────────────────────────────────────────────

    const addRowToGroup = (groupNo: number) => {
        const newRow: SensorRow = {
            id: nextId(), groupNo, conceptSensor: "", mappedSensorTag: "",
            mappedSensorName: "", modelType: "", modelNotes: "", additionalNotes: "", status: false,
        };
        setRows(prev => {
            const lastIdx = prev.map((r, i) => r.groupNo === groupNo ? i : -1).filter(i => i !== -1);
            const insertAt = lastIdx.length > 0 ? Math.max(...lastIdx) + 1 : prev.length;
            const next = [...prev];
            next.splice(insertAt, 0, newRow);
            return next;
        });
    };

    const removeRow = (id: string) => {
        setRows(prev => prev.filter(r => r.id !== id));
        if (selectedRowId === id) { setSelectedRowId(null); setShowModelPanel(false); }
    };

    const updateRow = (id: string, field: keyof SensorRow, value: string | number | boolean) => {
        setRows(prev => prev.map(r => {
            if (r.id !== id) return r;
            const updated = { ...r, [field]: value };
            if (field === 'mappedSensorTag') updated.mappedSensorName = getSensorName(value as string, sensorMetadata);
            return updated;
        }));
    };

    const selectSensorTag = (rowId: string, tag: string) => {
        updateRow(rowId, 'mappedSensorTag', tag);
        setDropdownRowId(null);
        setDropdownSearch("");
    };

    const handleRowClick = (rowId: string) => {
        setSelectedRowId(rowId);
        setShowModelPanel(true);
    };

    // ── Derived ──────────────────────────────────────────────────

    const getRowsForGroup = (groupNo: number) => rows.filter(r => r.groupNo === groupNo);
    const selectedRow = rows.find(r => r.id === selectedRowId);
    const filteredSensors = allSensors.filter(s => s.toLowerCase().includes(dropdownSearch.toLowerCase()));
    const sortedGroups = [...groups].sort((a, b) => a.no - b.no);

    // ── Upload / Download / Save ──────────────────────────────────

    const handleUpload = () => { alert("Upload .xlsx functionality is coming soon."); };

    const handleDownloadTemplate = () => {
        const headers = ["No.", "Group Name", "Concept Sensor", "Mapped Sensor Tag", "Mapped Sensor Name", "Model Type", "Model Notes", "Additional Notes", "Status"];
        const blob = new Blob([headers.join(",") + "\n"], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'failure_group_template.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    };

    const handleSave = () => {
        const headers = ["No.", "Group Name", "Concept Sensor", "Mapped Sensor Tag", "Mapped Sensor Name", "Model Type", "Model Notes", "Additional Notes", "Status"];
        const csvRows = rows.map(r => {
            const group = groups.find(g => g.no === r.groupNo);
            return [r.groupNo, group?.name || '', r.conceptSensor, r.mappedSensorTag, r.mappedSensorName, r.modelType, r.modelNotes, r.additionalNotes, r.status ? "Yes" : "No"]
                .map(v => { const s = String(v); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; }).join(",");
        });
        const blob = new Blob([[headers.join(","), ...csvRows].join("\n")], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `failure_groups_${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    // ── Render ────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="predictive-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Loading data...</div>
            </div>
        );
    }

    return (
        <div className="predictive-container">
            {/* Title Bar */}
            <div data-tauri-drag-region className="predictive-titlebar">
                <h2 className="predictive-title">Predictive Mode — Failure Group Creation</h2>
                <button onClick={handleClose} className="predictive-close-btn">&times;</button>
            </div>

            <div className="fg-body">
                <div className={`fg-table-area ${showModelPanel ? 'fg-table-area--split' : ''}`}>
                    {/* Toolbar */}
                    <div className="fg-toolbar">
                        <div className="fg-toolbar-left">
                            <button className="fg-upload-btn" onClick={handleUpload}>
                                <Upload size={14} /> Upload Filled Failure Group
                            </button>
                            <button className="fg-download-btn" onClick={handleDownloadTemplate}>
                                <Download size={14} /> Download Template
                            </button>
                        </div>
                        <div className="fg-toolbar-right">
                            <button className="fg-save-btn" onClick={handleSave}>
                                <Save size={14} /> Save
                            </button>
                        </div>
                    </div>

                    {/* Groups */}
                    <div className="fg-groups-container">
                        {sortedGroups.map(group => {
                            const groupRows = getRowsForGroup(group.no);
                            const isUngrouped = group.no === 0;

                            return (
                                <div key={group.no} className={`fg-group-card ${isUngrouped ? 'fg-group-card--ungrouped' : ''}`}>
                                    {/* Group Header */}
                                    <div className="fg-group-card-header" onClick={() => toggleGroupCollapse(group.no)}>
                                        <div className="fg-group-card-header-left">
                                            {group.isCollapsed ? <ChevronRight size={14} className="fg-group-chevron" /> : <ChevronDown size={14} className="fg-group-chevron" />}
                                            <span className={`fg-group-badge ${isUngrouped ? 'fg-group-badge--muted' : ''}`}>{group.no}</span>
                                            {editingGroupNo === group.no ? (
                                                <input className="fg-group-name-input" value={editingGroupName}
                                                    onChange={e => setEditingGroupName(e.target.value)}
                                                    onBlur={finishEditingGroupName}
                                                    onKeyDown={e => { if (e.key === 'Enter') finishEditingGroupName(); }}
                                                    onClick={e => e.stopPropagation()} autoFocus
                                                />
                                            ) : (
                                                <span className="fg-group-name">{group.name}</span>
                                            )}
                                            <span className="fg-group-count">{groupRows.length} sensor(s)</span>
                                        </div>
                                        <div className="fg-group-card-header-actions" onClick={e => e.stopPropagation()}>
                                            {!isUngrouped && (
                                                <button className="fg-icon-btn fg-icon-btn-edit" onClick={() => startEditingGroupName(group.no)} title="Rename group">
                                                    <Edit3 size={12} />
                                                </button>
                                            )}
                                            <button className="fg-icon-btn fg-icon-btn-add" onClick={() => addRowToGroup(group.no)} title="Add sensor">
                                                <Plus size={12} />
                                            </button>
                                            {!isUngrouped && (
                                                <button className="fg-icon-btn fg-icon-btn-danger" onClick={() => removeGroup(group.no)} title="Remove group">
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Group Body — Sensor Cards */}
                                    {!group.isCollapsed && (
                                        <div className="fg-group-card-body">
                                            {groupRows.length === 0 ? (
                                                <div className="fg-group-empty">
                                                    <span>No sensor rows yet.</span>
                                                    <button className="fg-group-empty-add" onClick={() => addRowToGroup(group.no)}>
                                                        <Plus size={12} /> Add Sensor
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="fg-sensor-cards">
                                                    {groupRows.map(row => {
                                                        const isSelected = selectedRowId === row.id;
                                                        const tagMissing = row.mappedSensorTag && !allSensors.some(s => s.toLowerCase() === row.mappedSensorTag.toLowerCase());

                                                        return (
                                                            <div
                                                                key={row.id}
                                                                className={`fg-sensor-card ${isSelected ? 'fg-sensor-card--selected' : ''}`}
                                                                onClick={() => handleRowClick(row.id)}
                                                            >
                                                                {/* Card Header */}
                                                                <div className="fg-sensor-card-top">
                                                                    <div className="fg-sensor-card-tag-area" onClick={e => e.stopPropagation()}>
                                                                        <div className="fg-sensor-tag-wrapper">
                                                                            <button
                                                                                className={`fg-sensor-tag-btn ${tagMissing ? 'fg-sensor-tag-btn--warning' : ''} ${row.mappedSensorTag ? 'fg-sensor-tag-btn--filled' : ''}`}
                                                                                onClick={() => { dropdownRowId === row.id ? setDropdownRowId(null) : (setDropdownRowId(row.id), setDropdownSearch("")); }}
                                                                            >
                                                                                <span>{row.mappedSensorTag || 'Select sensor tag...'}</span>
                                                                                {tagMissing && <AlertTriangle size={12} className="fg-warning-icon" />}
                                                                                <ChevronDown size={12} />
                                                                            </button>
                                                                            {dropdownRowId === row.id && (
                                                                                <div className="fg-sensor-dropdown" ref={dropdownRef}>
                                                                                    <div className="fg-sensor-dropdown-search">
                                                                                        <input type="text" placeholder="Search sensor..." value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)} autoFocus />
                                                                                    </div>
                                                                                    <div className="fg-sensor-dropdown-list">
                                                                                        {filteredSensors.length === 0 ? (
                                                                                            <div className="fg-sensor-dropdown-empty">No sensors found</div>
                                                                                        ) : filteredSensors.map(s => (
                                                                                            <button key={s} className={`fg-sensor-dropdown-item ${row.mappedSensorTag === s ? 'selected' : ''}`} onClick={() => selectSensorTag(row.id, s)}>
                                                                                                {s}
                                                                                            </button>
                                                                                        ))}
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    <div className="fg-sensor-card-actions" onClick={e => e.stopPropagation()}>
                                                                        <label className="fg-status-label">
                                                                            <input type="checkbox" className="fg-status-checkbox" checked={row.status} onChange={e => updateRow(row.id, 'status', e.target.checked)} />
                                                                            <span className={`fg-status-dot ${row.status ? 'fg-status-dot--active' : ''}`}></span>
                                                                        </label>
                                                                        <button className="fg-icon-btn fg-icon-btn-danger" onClick={() => removeRow(row.id)} title="Remove sensor">
                                                                            <X size={12} />
                                                                        </button>
                                                                    </div>
                                                                </div>

                                                                {/* Mapped sensor name auto-display */}
                                                                {row.mappedSensorName && (
                                                                    <div className="fg-sensor-card-mapped-name">{row.mappedSensorName}</div>
                                                                )}

                                                                {/* Card Fields Grid */}
                                                                <div className="fg-sensor-card-fields" onClick={e => e.stopPropagation()}>
                                                                    <div className="fg-field">
                                                                        <label>Concept Sensor</label>
                                                                        <input type="text" value={row.conceptSensor} placeholder="e.g. crankcase vibration" onChange={e => updateRow(row.id, 'conceptSensor', e.target.value)} />
                                                                    </div>
                                                                    <div className="fg-field">
                                                                        <label>Model Type</label>
                                                                        <input type="text" value={row.modelType} placeholder="e.g. I + R" onChange={e => updateRow(row.id, 'modelType', e.target.value)} />
                                                                    </div>
                                                                    <div className="fg-field">
                                                                        <label>Model Notes</label>
                                                                        <input type="text" value={row.modelNotes} placeholder="Notes..." onChange={e => updateRow(row.id, 'modelNotes', e.target.value)} />
                                                                    </div>
                                                                    <div className="fg-field">
                                                                        <label>Additional Notes</label>
                                                                        <input type="text" value={row.additionalNotes} placeholder="Additional..." onChange={e => updateRow(row.id, 'additionalNotes', e.target.value)} />
                                                                    </div>
                                                                </div>

                                                                {/* Build Model Button */}
                                                                {row.mappedSensorTag && (
                                                                    <button
                                                                        className="fg-build-model-btn"
                                                                        onClick={(e) => { e.stopPropagation(); handleBuildModel(row); }}
                                                                    >
                                                                        <BarChart3 size={12} /> Build Model
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}

                                            {groupRows.length > 0 && (
                                                <button className="fg-inline-add-row" onClick={() => addRowToGroup(group.no)}>
                                                    <Plus size={12} /> Add sensor
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {/* New Group */}
                        {showNewGroupDialog ? (
                            <div className="fg-new-group-dialog">
                                <div className="fg-new-group-dialog-header"><FolderPlus size={16} /> Create New Failure Group</div>
                                <div className="fg-new-group-dialog-body">
                                    <label>Group Name</label>
                                    <input ref={newGroupInputRef} type="text" className="fg-new-group-input" value={newGroupName}
                                        onChange={e => setNewGroupName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') createGroup(); if (e.key === 'Escape') { setShowNewGroupDialog(false); setNewGroupName(""); } }}
                                        placeholder="e.g. crankcase condition"
                                    />
                                </div>
                                <div className="fg-new-group-dialog-actions">
                                    <button className="fg-new-group-cancel" onClick={() => { setShowNewGroupDialog(false); setNewGroupName(""); }}>Cancel</button>
                                    <button className="fg-new-group-create" onClick={createGroup}><Plus size={14} /> Create Group</button>
                                </div>
                            </div>
                        ) : (
                            <button className="fg-add-group-btn" onClick={() => setShowNewGroupDialog(true)}>
                                <FolderPlus size={16} /> <span>Add New Failure Group</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Right: Model Build Panel */}
                {showModelPanel && selectedRow && (
                    <div className="fg-model-panel">
                        <div className="fg-model-panel-header">
                            <span>Model Build — {selectedRow.mappedSensorTag || 'Select Sensor'}</span>
                            <button className="predictive-close-btn" onClick={() => { setShowModelPanel(false); setSelectedRowId(null); }}>&times;</button>
                        </div>
                        <div className="fg-model-panel-body">
                            <div className="fg-model-info-grid">
                                <div className="fg-model-info-item">
                                    <span className="fg-model-info-label">Group</span>
                                    <span className="fg-model-info-value">{groups.find(g => g.no === selectedRow.groupNo)?.name || 'Unknown'} (No. {selectedRow.groupNo})</span>
                                </div>
                                <div className="fg-model-info-item">
                                    <span className="fg-model-info-label">Concept Sensor</span>
                                    <span className="fg-model-info-value">{selectedRow.conceptSensor || '—'}</span>
                                </div>
                                <div className="fg-model-info-item">
                                    <span className="fg-model-info-label">Mapped Sensor Tag</span>
                                    <span className="fg-model-info-value">{selectedRow.mappedSensorTag || '—'}</span>
                                </div>
                                <div className="fg-model-info-item">
                                    <span className="fg-model-info-label">Mapped Sensor Name</span>
                                    <span className="fg-model-info-value">{selectedRow.mappedSensorName || '—'}</span>
                                </div>
                                <div className="fg-model-info-item">
                                    <span className="fg-model-info-label">Model Type</span>
                                    <span className="fg-model-info-value">{selectedRow.modelType || '—'}</span>
                                </div>
                            </div>
                            <div className="fg-model-placeholder">
                                <div className="fg-model-placeholder-icon">📊</div>
                                <p>Model Build tools will appear here</p>
                                <p className="fg-model-placeholder-sub">Select a sensor row to configure its model</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
