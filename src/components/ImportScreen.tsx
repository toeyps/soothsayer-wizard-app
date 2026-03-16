import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { CsvMetadata, SensorMetadata, WorkspaceMetadata, WorkspaceState } from "../types";
import { FileText, ArrowRight, X, Upload, File, Clock, Plus, MoreVertical, Trash2, Copy, Edit2, Layout, Database, Settings } from "lucide-react";
import { getRecentWorkspaces, loadWorkspaceData, saveWorkspaceData, deleteWorkspace, duplicateWorkspace, renameWorkspaceFile } from "../workspaceManager";

interface ImportScreenProps {
    onDataReady: (data: CsvMetadata, sensorMetadata: SensorMetadata[] | null, workspaceState: WorkspaceState) => void;
}

export default function ImportScreen({ onDataReady }: ImportScreenProps) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dataFilePaths, setDataFilePaths] = useState<string[]>([]);
    const [metadataFilePath, setMetadataFilePath] = useState<string | null>(null);
    const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceMetadata[]>([]);
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const refreshWorkspaces = () => {
        getRecentWorkspaces().then(setRecentWorkspaces).catch(console.error);
    };

    useEffect(() => {
        refreshWorkspaces();
    }, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setActiveMenuId(null);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleRemoveFile = (index: number, e: React.MouseEvent) => {
        e.stopPropagation();
        const newPaths = [...dataFilePaths];
        newPaths.splice(index, 1);
        setDataFilePaths(newPaths);
    };

    const handleSelectDataFile = async () => {
        if (loading) return;
        try {
            const selected = await openDialog({
                multiple: true,
                filters: [{ name: 'CSV', extensions: ['csv'] }]
            });
            if (selected) {
                let newFiles: string[] = [];
                if (Array.isArray(selected)) {
                    newFiles = selected;
                } else if (typeof selected === 'string') {
                    newFiles = [selected];
                }
                setDataFilePaths(prev => {
                    const uniqueNew = newFiles.filter(f => !prev.includes(f));
                    return [...prev, ...uniqueNew];
                });
                setError(null);
            }
        } catch (err) {
            setError(String(err));
        }
    };

    const handleSelectMetadataFile = async () => {
        if (loading) return;
        try {
            const selected = await openDialog({
                multiple: false,
                filters: [{ name: 'CSV', extensions: ['csv'] }]
            });
            if (selected && typeof selected === 'string') {
                setMetadataFilePath(selected);
                setError(null);
            }
        } catch (err) {
            setError(String(err));
        }
    };

    const processData = async (dataPaths: string[], metaPath: string | null, workspaceId: string, existingState?: WorkspaceState) => {
        const dataMetadata = await invoke<CsvMetadata>("load_csv", { paths: dataPaths });
        let sensorMetadata: SensorMetadata[] | null = null;
        if (metaPath) {
            sensorMetadata = await invoke<SensorMetadata[]>("load_metadata_command", { path: metaPath });
        }
        const state: WorkspaceState = existingState || {
            id: workspaceId,
            name: `Workspace ${new Date().toLocaleString()}`,
            lastRoute: 'dashboard',
            dataFilePaths: dataPaths,
            metadataFilePath: metaPath,
            selectedSensors: [],
            visibleSensors: [],
            operationConfig: null
        };
        await saveWorkspaceData(state);
        onDataReady(dataMetadata, sensorMetadata, state);
    };

    const loadWorkspace = async (workspaceId: string) => {
        if (activeMenuId) return;
        setLoading(true);
        setError(null);
        try {
            const state = await loadWorkspaceData(workspaceId);
            if (!state) throw new Error("Workspace not found");
            await processData(state.dataFilePaths, state.metadataFilePath, state.id, state);
        } catch (err) {
            setError(String(err));
            setLoading(false);
        }
    };

    const handleAnalyze = async () => {
        if (dataFilePaths.length === 0) return;
        setLoading(true);
        setError(null);
        try {
            const newWorkspaceId = `ws_${Date.now()}`;
            await processData(dataFilePaths, metadataFilePath, newWorkspaceId);
        } catch (err) {
            setError(String(err));
            setLoading(false);
        }
    };

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        
        const confirmed = await ask("Are you sure you want to delete this workspace? This action cannot be undone.", {
            title: 'Delete Workspace',
            kind: 'warning'
        });

        if (confirmed) {
            await deleteWorkspace(id);
            refreshWorkspaces();
            setActiveMenuId(null);
        }
    };

    const handleDuplicate = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        await duplicateWorkspace(id);
        refreshWorkspaces();
        setActiveMenuId(null);
    };

    const handleRename = async (ws: WorkspaceMetadata, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const newName = prompt("Rename workspace:", ws.name);
        if (newName && newName.trim() !== "" && newName !== ws.name) {
            await renameWorkspaceFile(ws.id, newName);
            refreshWorkspaces();
        }
        setActiveMenuId(null);
    };

    const formatTime = (ts: number) => {
        const d = new Date(ts);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    };

    return (
        <div style={{ 
            display: 'flex', 
            width: '100%', 
            height: '100%', 
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontFamily: '"Inter", sans-serif'
        }}>
            {/* Sidebar - Recent Workspaces (Nanobanana Style) */}
            <div style={{
                width: '340px',
                background: 'rgba(15, 23, 42, 0.4)',
                backdropFilter: 'blur(12px)',
                borderRight: '1px solid rgba(255, 255, 255, 0.05)',
                display: 'flex',
                flexDirection: 'column',
                padding: '2.5rem 1.5rem',
                overflowY: 'auto'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '2.5rem', paddingLeft: '0.5rem' }}>
                    <Layout size={20} color="var(--accent-color)" />
                    <h2 style={{ fontSize: '1.1rem', fontWeight: 600, letterSpacing: '0.02em', opacity: 0.9 }}>
                        Recent Workspaces
                    </h2>
                </div>

                {recentWorkspaces.length === 0 ? (
                    <div style={{ color: 'var(--text-secondary)', padding: '1rem', fontSize: '0.85rem', opacity: 0.5, textAlign: 'center', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '12px' }}>
                        No workspaces found.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {recentWorkspaces.map(ws => (
                            <div 
                                key={ws.id}
                                onClick={() => loadWorkspace(ws.id)}
                                style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    padding: '1rem',
                                    borderRadius: '12px',
                                    cursor: 'pointer',
                                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                                    background: activeMenuId === ws.id ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                                    border: '1px solid transparent',
                                    position: 'relative'
                                }}
                                onMouseEnter={(e) => {
                                    if (activeMenuId !== ws.id) {
                                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (activeMenuId !== ws.id) {
                                        e.currentTarget.style.background = 'transparent';
                                        e.currentTarget.style.borderColor = 'transparent';
                                    }
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontWeight: 500, fontSize: '0.9rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                                        {ws.name}
                                    </span>
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); setActiveMenuId(activeMenuId === ws.id ? null : ws.id); }}
                                        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px', opacity: 0.6 }}
                                    >
                                        <MoreVertical size={14} />
                                    </button>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.4rem', opacity: 0.5 }}>
                                    <Clock size={10} />
                                    <span>{formatTime(ws.lastModified)}</span>
                                </div>

                                {activeMenuId === ws.id && (
                                    <div 
                                        ref={menuRef}
                                        style={{
                                            position: 'absolute',
                                            top: '40px',
                                            right: '10px',
                                            background: 'rgba(30, 41, 59, 0.95)',
                                            backdropFilter: 'blur(16px)',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            borderRadius: '10px',
                                            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.4)',
                                            zIndex: 100,
                                            padding: '5px',
                                            minWidth: '150px'
                                        }}
                                    >
                                        <button onClick={(e) => handleRename(ws, e)} style={menuItemStyle} onMouseEnter={hM} onMouseLeave={lM}><Edit2 size={12} /> Rename</button>
                                        <button onClick={(e) => handleDuplicate(ws.id, e)} style={menuItemStyle} onMouseEnter={hM} onMouseLeave={lM}><Copy size={12} /> Duplicate</button>
                                        <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)', margin: '4px 0' }} />
                                        <button onClick={(e) => handleDelete(ws.id, e)} style={{...menuItemStyle, color: '#f87171'}} onMouseEnter={hM} onMouseLeave={lM}><Trash2 size={12} /> Delete</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Main Area - Glassmorphism Import Section */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem', position: 'relative', overflow: 'hidden' }}>
                {/* Background Glow Decorations */}
                <div style={{ position: 'absolute', top: '-10%', right: '-10%', width: '40%', height: '40%', background: 'radial-gradient(circle, rgba(56, 189, 248, 0.08) 0%, transparent 70%)', filter: 'blur(60px)', zIndex: 0 }} />
                <div style={{ position: 'absolute', bottom: '-10%', left: '-5%', width: '35%', height: '35%', background: 'radial-gradient(circle, rgba(139, 92, 246, 0.05) 0%, transparent 70%)', filter: 'blur(60px)', zIndex: 0 }} />

                <div style={{ width: '100%', maxWidth: '860px', marginBottom: '3rem', zIndex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                        <div style={{ background: 'var(--accent-color)', width: '24px', height: '4px', borderRadius: '4px' }} />
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, letterSpacing: '0.1em', color: 'var(--accent-color)', textTransform: 'uppercase' }}>Workflow Start</span>
                    </div>
                    <h1 style={{ fontSize: '2.75rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: '0.5rem' }}>
                        Create New Workspace
                    </h1>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', opacity: 0.7 }}>
                        Aggregate your sensor data and metadata to begin analysis.
                    </p>
                </div>

                {/* Grid for two main dropzones */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', width: '100%', maxWidth: '860px', zIndex: 1 }}>
                    {/* Raw Data Card */}
                    <div style={glassCardStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                            <div style={iconBoxStyle}><Database size={18} /></div>
                            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Raw Sensor Data</h3>
                        </div>
                        
                        <div
                            onClick={handleSelectDataFile}
                            style={dropZoneStyle}
                            onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.borderColor = 'var(--accent-color)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; } }}
                            onMouseLeave={(e) => { if (!loading) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(255,255,255,0.01)'; } }}
                        >
                            <Plus size={28} style={{ marginBottom: '12px', opacity: 0.5 }} strokeWidth={1.5} />
                            <span style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.6 }}>Select CSV Files</span>
                        </div>

                        {dataFilePaths.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' }}>
                                {dataFilePaths.map((path, index) => (
                                    <div key={index} style={fileItemStyle}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', overflow: 'hidden' }}>
                                            <FileText size={14} style={{ opacity: 0.5 }} />
                                            <span style={{ fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{path.split(/[/\\]/).pop()}</span>
                                        </div>
                                        <button onClick={(e) => handleRemoveFile(index, e)} style={removeBtnStyle}><X size={12} /></button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Metadata Card */}
                    <div style={glassCardStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                            <div style={iconBoxStyle}><Settings size={18} /></div>
                            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Metadata (Optional)</h3>
                        </div>

                        {metadataFilePath ? (
                            <div style={{ ...fileItemStyle, padding: '1rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', overflow: 'hidden' }}>
                                    <File size={18} color="var(--accent-color)" />
                                    <span style={{ fontSize: '0.85rem' }}>{metadataFilePath.split(/[/\\]/).pop()}</span>
                                </div>
                                <button onClick={() => setMetadataFilePath(null)} style={removeBtnStyle}><X size={16} /></button>
                            </div>
                        ) : (
                            <div
                                onClick={handleSelectMetadataFile}
                                style={{ ...dropZoneStyle, height: '120px' }}
                                onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.borderColor = 'var(--accent-color)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; } }}
                                onMouseLeave={(e) => { if (!loading) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(255,255,255,0.01)'; } }}
                            >
                                <Upload size={24} style={{ marginBottom: '10px', opacity: 0.5 }} />
                                <span style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.6 }}>Add Metadata</span>
                            </div>
                        )}
                        <p style={{ marginTop: '1rem', fontSize: '0.75rem', opacity: 0.4, lineHeight: 1.5 }}>
                            Provide a metadata CSV to map sensor tags to friendly names and units.
                        </p>
                    </div>
                </div>

                <div style={{ width: '100%', maxWidth: '860px', marginTop: '2.5rem', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '2rem', zIndex: 1 }}>
                    {error && <div style={{ color: '#f87171', fontSize: '0.85rem', fontWeight: 500 }}>{error}</div>}
                    <button
                        style={{ 
                            background: 'var(--accent-color)', 
                            border: 'none', 
                            padding: '0.9rem 2.5rem', 
                            borderRadius: '100px', 
                            color: '#ffffff', 
                            fontWeight: 700, 
                            fontSize: '0.95rem', 
                            cursor: (dataFilePaths.length === 0 || loading) ? 'not-allowed' : 'pointer', 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '0.75rem', 
                            opacity: (dataFilePaths.length === 0 || loading) ? 0.4 : 1,
                            boxShadow: '0 8px 20px -4px rgba(56, 189, 248, 0.3)',
                            transition: 'all 0.3s ease'
                        }}
                        onClick={handleAnalyze}
                        disabled={dataFilePaths.length === 0 || loading}
                        onMouseEnter={(e) => { if (!loading && dataFilePaths.length > 0) e.currentTarget.style.transform = 'translateY(-2px)'; }}
                        onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
                    >
                        {loading ? 'Processing...' : 'Initialize Analysis'}
                        {!loading && <ArrowRight size={18} />}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Nanobanana Helper Styles
const glassCardStyle: React.CSSProperties = {
    background: 'rgba(255, 255, 255, 0.02)',
    backdropFilter: 'blur(8px)',
    borderRadius: '24px',
    border: '1px solid rgba(255, 255, 255, 0.05)',
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column'
};

const iconBoxStyle: React.CSSProperties = {
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    background: 'rgba(56, 189, 248, 0.1)',
    color: 'var(--accent-color)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
};

const dropZoneStyle: React.CSSProperties = {
    border: '1px dashed rgba(255, 255, 255, 0.15)',
    borderRadius: '16px',
    height: '120px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    background: 'rgba(255, 255, 255, 0.01)',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
};

const fileItemStyle: React.CSSProperties = {
    background: 'rgba(255, 255, 255, 0.03)',
    borderRadius: '8px',
    padding: '0.6rem 0.8rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    border: '1px solid rgba(255, 255, 255, 0.03)'
};

const removeBtnStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    opacity: 0.5
};

const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-primary)',
    padding: '10px 14px',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: '0.8rem',
    borderRadius: '6px',
    transition: 'background 0.2s'
};

const hM = (e: React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    if (target.style.color === 'rgb(248, 113, 113)') {
        target.style.background = 'rgba(248, 113, 113, 0.1)';
    } else {
        target.style.background = 'rgba(255, 255, 255, 0.05)';
    }
};
const lM = (e: React.MouseEvent) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; };
