import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata } from "../../types";
import { loadWorkspaceData } from "../../workspaceManager";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";

interface BuildModelOverviewData {
    workspaceId: string;
    sensorMetadata: SensorMetadata[] | null;
}

const KIND_ABBREV: Record<ModelKind, string> = {
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
    performance: 'Performance',
    condition: 'Condition',
};

// Mirrors Dashboard.tsx's own FG_GROUP_PALETTE/getFgGroupColor exactly
// (duplicated, not imported — sub-windows don't share a components module)
// so a group renders the same color here as it does on the Dashboard tab.
const FG_GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;
const getFgGroupColor = (no: number): string =>
    no === 0 ? 'slate' : FG_GROUP_PALETTE[(no - 1) % FG_GROUP_PALETTE.length];

const UNCATEGORIZED = 'Uncategorized';

type GroupBy = 'fg' | 'component';

/**
 * "Browse before you build" summary layer — read-only, shows every model
 * from every Failure Group in one place, switchable between grouping by
 * Failure Group or by Component. This is the window Dashboard's "Build
 * Model" button opens; clicking a section or model row here opens that
 * model's own group's dedicated Build Model window (unchanged) — this
 * window never edits anything itself, it only helps decide which group to
 * open next. Singleton (like PredictiveModelBuild) since it always shows
 * the whole workspace, not one group — no reason for more than one instance.
 */
export default function BuildModelOverviewWindow() {
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [allGroups, setAllGroups] = useState<FailureGroup[]>([]);
    const [allModels, setAllModels] = useState<FailureModel[]>([]);
    const [loading, setLoading] = useState(true);
    const [groupBy, setGroupBy] = useState<GroupBy>('fg');

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    // "description (tag)" — same formatting as the per-group Build Model
    // window, falling back to the bare tag when unmapped.
    const sensorLabel = useCallback((tag: string) => {
        const desc = sensorMetaMap.get(normalizeSensorTag(tag))?.description;
        return desc ? `${desc} (${tag})` : tag;
    }, [sensorMetaMap]);

    // Same fallback chain as FailureGroupsPanel/BuildModelWindow: the
    // model's own name if set (and not just its legacy-migrated tag), else
    // "description (tag)" for its target sensor, else the bare tag, else a
    // placeholder for a brand-new model with nothing picked yet.
    const modelDisplayLabel = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? model.ySensor : model.targetSensor;
        const trimmedName = model.name.trim();
        if (trimmedName && trimmedName !== targetTag) return trimmedName;
        if (!targetTag) return 'Untitled model';
        return sensorLabel(targetTag);
    }, [sensorLabel]);

    const modelComponent = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? model.ySensor : model.targetSensor;
        if (!targetTag) return UNCATEGORIZED;
        return sensorMetaMap.get(normalizeSensorTag(targetTag))?.component || UNCATEGORIZED;
    }, [sensorMetaMap]);

    useEffect(() => {
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        let unlistenData: (() => void) | undefined;
        let unlistenChanged: (() => void) | undefined;

        const setup = async () => {
            unlistenData = await listen<BuildModelOverviewData>('build-model-overview-data', async (event) => {
                const d = event.payload;
                setSensorMetadata(d.sensorMetadata);
                try {
                    const ws = await loadWorkspaceData(d.workspaceId);
                    setAllGroups(ws?.failureGroupState?.groups ?? []);
                    setAllModels(ws?.failureGroupState?.models ?? []);
                } catch (e) {
                    console.warn('Failed to hydrate failure-group state:', e);
                }
                setLoading(false);
            });

            // Any window that persists failureGroupState (Dashboard, a
            // per-group Build Model window, PredictiveModelBuild) broadcasts
            // this so this overview never goes stale while left open.
            unlistenChanged = await listen<{ groups: FailureGroup[]; models: FailureModel[] }>('failure-group-state-changed', (event) => {
                setAllGroups(event.payload.groups);
                setAllModels(event.payload.models);
            });

            await emit('request-build-model-overview-data');
        };

        setup();

        return () => {
            if (unlistenData) unlistenData();
            if (unlistenChanged) unlistenChanged();
        };
    }, []);

    // Dashboard is the one that actually spawns the per-group window (it
    // holds the CSV/raw sensor data those windows need) — this window just
    // asks for it, same pattern BuildModelWindow uses for launching PM.
    const openGroup = (groupNo: number) => {
        emit('open-build-model', { groupNo });
    };

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    if (loading) {
        return <div style={{ background: 'var(--bg-primary)', height: '100vh' }} />;
    }

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModels = allModels.length;

    const componentSections = (() => {
        const byComp = new Map<string, FailureModel[]>();
        for (const m of allModels) {
            const key = modelComponent(m);
            if (!byComp.has(key)) byComp.set(key, []);
            byComp.get(key)!.push(m);
        }
        return Array.from(byComp.entries()).sort(([a], [b]) => a.localeCompare(b));
    })();

    const modelRow = (model: FailureModel, showFgTag: boolean) => {
        const group = allGroups.find(g => g.no === model.groupNo);
        return (
            <div
                key={model.id}
                onClick={() => openGroup(model.groupNo)}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px 9px 18px', cursor: 'pointer', borderTop: '1px solid var(--border)' }}
            >
                <div className={`model-kind-icon model-kind-icon--${model.kind}`} style={{ width: '24px', height: '24px', fontSize: '0.62rem' }}>
                    {KIND_ABBREV[model.kind]}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    {showFgTag && (
                        <span className="model-chip model-chip--component" style={{ fontFamily: 'var(--mono)' }}>
                            FG-{model.groupNo}{group ? ` · ${group.name}` : ''}
                        </span>
                    )}
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{modelDisplayLabel(model)}</span>
                    {model.category && (
                        <span className={`model-chip model-chip--${model.category === 'performance' ? 'perf' : 'cond'}`}>
                            {CATEGORY_LABELS[model.category]}
                        </span>
                    )}
                </div>
                <span
                    className={`model-status-pill model-status-pill--${model.status ? 'complete' : 'incomplete'}`}
                    style={{ cursor: 'default' }}
                >
                    {model.status ? 'Complete' : 'Incomplete'}
                </span>
            </div>
        );
    };

    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Build Model — Overview
                </h2>
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <b style={{ color: 'var(--text-primary)' }}>{totalModels}</b> models ·
                    <b style={{ color: 'var(--text-primary)' }}>{realGroups.length}</b> groups ·
                    <b style={{ color: 'var(--text-primary)' }}>{componentSections.length}</b> components
                </div>
                <div style={{ display: 'inline-flex', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: '8px', padding: '3px', gap: '2px' }}>
                    {(['fg', 'component'] as GroupBy[]).map(mode => (
                        <button
                            key={mode}
                            onClick={() => setGroupBy(mode)}
                            style={{
                                fontSize: '0.78rem', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                                background: groupBy === mode ? 'var(--accent-color)' : 'none',
                                color: groupBy === mode ? '#06111f' : 'var(--text-secondary)',
                                fontWeight: groupBy === mode ? 600 : 500,
                            }}
                        >
                            {mode === 'fg' ? 'Group by Failure Group' : 'Group by Component'}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {groupBy === 'fg' ? (
                    realGroups.length === 0 ? (
                        <div className="no-results">No failure groups yet</div>
                    ) : realGroups.map(group => {
                        const models = allModels.filter(m => m.groupNo === group.no);
                        const color = getFgGroupColor(group.no);
                        return (
                            <div key={group.no} className={`fg-group-color-${color}`} style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
                                <div
                                    onClick={() => openGroup(group.no)}
                                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px', cursor: 'pointer' }}
                                >
                                    <span className="fg-group-dot" />
                                    <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{group.name}</span>
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-faint)' }}>FG-{group.no}</span>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                                </div>
                                {models.length === 0 ? (
                                    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px 10px 18px', fontSize: '0.72rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                                ) : models.map(m => modelRow(m, false))}
                            </div>
                        );
                    })
                ) : (
                    componentSections.length === 0 ? (
                        <div className="no-results">No models yet</div>
                    ) : componentSections.map(([comp, models]) => {
                        const initials = comp.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                        return (
                            <div key={comp} style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                    <span style={{ width: '26px', height: '26px', borderRadius: '7px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-hi)', border: '1px solid var(--border)', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                        {initials}
                                    </span>
                                    <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{comp}</span>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                                </div>
                                {models.map(m => modelRow(m, true))}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
