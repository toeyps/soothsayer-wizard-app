import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { Save, X } from "lucide-react";

export default function SaveAsWindow() {
    const [newName, setNewName] = useState("");
    const [loading, setLoading] = useState(true);

    // Read mode from URL; 'rename' repurposes this same dialog for renaming the current workspace
    // (different default name prefill, different title/button/submit-event).
    //
    // The plain 'save-as' mode (duplicate workspace under a new name) is
    // dead code as of the app-wide removal of the "Save As" feature — every
    // remaining caller of this component (useSubWindowMenu.ts's `doRename`)
    // always passes `mode=rename`. Left in place rather than stripped out,
    // since untangling the isRename branches below isn't necessary to
    // satisfy the removal and risks a regression in the rename path this
    // component still needs to serve correctly.
    const mode = new URLSearchParams(window.location.search).get('mode') === 'rename' ? 'rename' : 'save-as';
    const isRename = mode === 'rename';

    useEffect(() => {
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        let unlisten: (() => void) | undefined;

        const setup = async () => {
            unlisten = await listen<{ currentName: string }>('request-save-as-data-response', (event) => {
                setNewName(isRename ? event.payload.currentName : `${event.payload.currentName} (Copy)`);
                setLoading(false);
            });

            // Request initial data
            await emit('request-save-as-data');
        };

        setup();

        return () => {
            if (unlisten) unlisten();
        };
    }, [isRename]);

    const handleSave = async () => {
        if (newName.trim() === "") return;
        await emit(isRename ? 'rename-submit' : 'save-as-submit', { newName });
        await getCurrentWindow().close();
    };

    const handleCancel = async () => {
        await getCurrentWindow().close();
    };

    if (loading) {
        return <div style={{ background: 'var(--bg-primary)', height: '100vh' }} />;
    }

    return (
        <div style={{
            background: 'var(--bg-primary)',
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            color: 'var(--text-primary)',
            fontFamily: '"Inter", sans-serif',
            overflow: 'hidden',
            border: '1px solid var(--border)',
            borderRadius: '12px'
        }}>
            {/* Header */}
            <div data-tauri-drag-region style={{
                padding: '1rem 1.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.02)',
                cursor: 'move'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <Save size={18} color="var(--accent-color)" />
                    <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>{isRename ? 'Rename Workspace' : 'Save Workspace As'}</h2>
                </div>
                <button onClick={handleCancel} style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px'
                }}>
                    <X size={20} />
                </button>
            </div>

            {/* Content */}
            <div style={{ padding: '2rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.7 }}>New Workspace Name</label>
                    <input
                        autoFocus
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                        placeholder="Enter workspace name..."
                        style={{
                            background: 'var(--input-bg)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            padding: '0.75rem 1rem',
                            color: 'var(--text-primary)',
                            fontSize: '0.95rem',
                            outline: 'none',
                            transition: 'border-color 0.2s'
                        }}
                        onFocus={(e) => e.target.style.borderColor = 'var(--accent-color)'}
                        onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
                    />
                </div>
                
                <p style={{ fontSize: '0.8rem', opacity: 0.5, margin: 0, lineHeight: 1.5 }}>
                    {isRename
                        ? 'This will rename the current workspace. No new copy will be created.'
                        : 'This will create a duplicate of your current workspace settings, including all selected sensors and configurations.'}
                </p>
            </div>

            {/* Footer */}
            <div style={{
                padding: '1.25rem 1.5rem',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '1rem',
                background: 'rgba(255,255,255,0.02)',
                borderTop: '1px solid var(--border)'
            }}>
                <button 
                    onClick={handleCancel}
                    style={{
                        padding: '0.6rem 1.25rem',
                        borderRadius: '8px',
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                        fontSize: '0.9rem',
                        fontWeight: 500,
                        cursor: 'pointer'
                    }}
                >
                    Cancel
                </button>
                <button 
                    onClick={handleSave}
                    disabled={newName.trim() === ""}
                    style={{
                        padding: '0.6rem 1.5rem',
                        borderRadius: '8px',
                        background: 'var(--accent-color)',
                        border: 'none',
                        color: '#fff',
                        fontSize: '0.9rem',
                        fontWeight: 600,
                        cursor: newName.trim() === "" ? 'not-allowed' : 'pointer',
                        opacity: newName.trim() === "" ? 0.5 : 1,
                        boxShadow: '0 4px 12px rgba(56, 189, 248, 0.2)'
                    }}
                >
                    {isRename ? 'Rename' : 'Save Copy'}
                </button>
            </div>
        </div>
    );
}
