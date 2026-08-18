import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { X, Plus, ChevronRight } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata } from "../../types";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";

interface BuildModelData {
    workspaceId: string;
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
}

const KIND_LABELS: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

const KIND_ABBREV: Record<ModelKind, string> = {
    individual: 'IND',
    relationship: 'REL',
    clustering: 'CLU',
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
    performance: 'Performance',
    condition: 'Condition',
};

function makeDefaultModel(groupNo: number): FailureModel {
    return {
        id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        groupNo,
        name: '',
        kind: 'individual',
        category: null,
        notes: '',
        status: false,
        targetSensor: '',
        predictorSensors: [],
        xSensor: '',
        ySensor: '',
        individualChecked: true,
        rcMode: null,
        scatterXSensor: '',
        relModelName: '',
        relStiffness: 100_000,
        clusterModelName: '',
        numClusters: 3,
        criteriaSensor: '',
        clusterRanges: [
            { min: 0, max: 33 },
            { min: 33, max: 66 },
            { min: 66, max: 100 },
        ],
        filterTimeStart: '',
        filterTimeEnd: '',
        pmSensorFilters: [],
    };
}

function sensorSummary(model: FailureModel): string {
    if (model.kind === 'individual') return `Target: ${model.targetSensor || '—'}`;
    if (model.kind === 'relationship') return `Target: ${model.targetSensor || '—'} · Predictors: ${(model.predictorSensors ?? []).join(', ') || '—'}`;
    return `X: ${model.xSensor || '—'} · Y: ${model.ySensor || '—'}${model.criteriaSensor ? ` · Criteria: ${model.criteriaSensor}` : ''}`;
}

/**
 * Dedicated per-group window for managing a Failure Group's description,
 * recommendation, and the FailureModels inside it — the redesign's
 * replacement for the old inline per-row editor in FailureGroupsPanel.tsx
 * (that panel is now preview-only; see its own doc comment). One OS window
 * per group (label `build-model-${groupNo}`, spawned from Dashboard.tsx), so
 * the user can compare two groups side by side.
 *
 * Model list rows are compact summaries (kind icon, name, category/component
 * chips, sensor summary, status pill, "Open in Predictive Model" button) —
 * clicking a row opens the same form used to add a model, prefilled, so
 * editing an existing model's name/kind/category/sensors reuses one code
 * path instead of two. This mirrors the approved mockup's model-card layout;
 * see `docs/PROJECT_HANDOVER.md`'s 2026-08-18 entries for why an earlier
 * version of this file drifted from it.
 *
 * Owns `failureGroupState` jointly with Dashboard and PredictiveModelBuild —
 * every write here is a read-modify-write against the full workspace file
 * (never touching other groups' models) and broadcasts
 * `failure-group-state-changed` afterward so those other windows never see
 * stale data. See Dashboard.tsx's own listener for why this matters.
 */
export default function BuildModelWindow() {
    const groupNo = useMemo(() => Number(new URLSearchParams(window.location.search).get('groupNo')) || 0, []);

    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [allGroups, setAllGroups] = useState<FailureGroup[]>([]);
    const [allModels, setAllModels] = useState<FailureModel[]>([]);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    const [descDraft, setDescDraft] = useState('');
    const [recDraft, setRecDraft] = useState('');

    // Form serves both "+ Add Model" (editingModelId === null) and clicking
    // an existing row to edit it (editingModelId === that model's id) — one
    // form, one validation path, one commit path.
    const [showForm, setShowForm] = useState(false);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [formName, setFormName] = useState('');
    const [formKind, setFormKind] = useState<ModelKind | null>(null);
    const [formCategory, setFormCategory] = useState<ModelCategory | null>(null);
    const [formTarget, setFormTarget] = useState('');
    const [formPredictors, setFormPredictors] = useState<string[]>([]);
    const [formX, setFormX] = useState('');
    const [formY, setFormY] = useState('');
    const [formCriteria, setFormCriteria] = useState('');
    const [formClusterRanges, setFormClusterRanges] = useState<{ min: number | null; max: number | null }[]>([]);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);

    useEffect(() => {
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        let unlistenData: (() => void) | undefined;
        let unlistenChanged: (() => void) | undefined;

        const setup = async () => {
            unlistenData = await listen<BuildModelData>('build-model-data', async (event) => {
                const d = event.payload;
                setWorkspaceId(d.workspaceId);
                setAllSensors(d.sensorHeaders);
                setSensorMetadata(d.sensorMetadata);
                try {
                    const ws = await loadWorkspaceData(d.workspaceId);
                    setAllGroups(ws?.failureGroupState?.groups ?? []);
                    setAllModels(ws?.failureGroupState?.models ?? []);
                } catch (e) {
                    console.warn('Failed to hydrate failure-group state:', e);
                }
                hydratedRef.current = true;
                setLoading(false);
            });

            // Any other window (Dashboard, another Build Model window,
            // PredictiveModelBuild) that persists failureGroupState
            // broadcasts this so our copy never goes stale.
            unlistenChanged = await listen<{ groups: FailureGroup[]; models: FailureModel[] }>('failure-group-state-changed', (event) => {
                setAllGroups(event.payload.groups);
                setAllModels(event.payload.models);
            });

            await emit('request-build-model-data');
        };

        setup();

        return () => {
            if (unlistenData) unlistenData();
            if (unlistenChanged) unlistenChanged();
        };
    }, []);

    const group = allGroups.find(g => g.no === groupNo) ?? null;
    const groupModels = useMemo(() => allModels.filter(m => m.groupNo === groupNo), [allModels, groupNo]);

    // Seed the description/recommendation drafts once, when the group first
    // becomes available — not on every `group` identity change, so the user
    // typing doesn't get clobbered by a `failure-group-state-changed` echo
    // of their own recent keystroke.
    const descSeededRef = useRef(false);
    useEffect(() => {
        if (descSeededRef.current || !group) return;
        descSeededRef.current = true;
        setDescDraft(group.description ?? '');
        setRecDraft(group.recommendation ?? '');
    }, [group]);

    const persist = useCallback(async (
        updater: (models: FailureModel[], groups: FailureGroup[]) => { models: FailureModel[]; groups: FailureGroup[] },
    ) => {
        if (!workspaceId) return;
        const next = await updateWorkspaceData(workspaceId, prev => {
            const groups = prev.failureGroupState?.groups ?? [];
            const models = prev.failureGroupState?.models ?? [];
            const result = updater(models, groups);
            return { ...prev, failureGroupState: { groups: result.groups, models: result.models } };
        });
        if (next?.failureGroupState) {
            setAllGroups(next.failureGroupState.groups);
            setAllModels(next.failureGroupState.models);
            await emit('failure-group-state-changed', next.failureGroupState);
        }
    }, [workspaceId]);

    // Debounced save of description/recommendation — mirrors
    // PredictiveModelBuild's own 250ms config-save debounce.
    useEffect(() => {
        if (!hydratedRef.current || !group) return;
        if (descDraft === (group.description ?? '') && recDraft === (group.recommendation ?? '')) return;
        const timer = setTimeout(() => {
            persist((models, groups) => ({
                models,
                groups: groups.map(g => g.no === groupNo ? { ...g, description: descDraft, recommendation: recDraft } : g),
            }));
        }, 250);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [descDraft, recDraft, groupNo]);

    const resetForm = () => {
        setEditingModelId(null);
        setFormName('');
        setFormKind(null);
        setFormCategory(null);
        setFormTarget('');
        setFormPredictors([]);
        setFormX('');
        setFormY('');
        setFormCriteria('');
        setFormClusterRanges([]);
        setShowForm(false);
    };

    const openAddForm = () => {
        resetForm();
        setShowForm(true);
    };

    const openEditForm = (model: FailureModel) => {
        setEditingModelId(model.id);
        setFormName(model.name);
        setFormKind(model.kind);
        setFormCategory(model.category);
        setFormTarget(model.targetSensor ?? '');
        setFormPredictors(model.predictorSensors ?? []);
        setFormX(model.xSensor ?? '');
        setFormY(model.ySensor ?? '');
        setFormCriteria(model.criteriaSensor ?? '');
        setFormClusterRanges(model.clusterRanges?.length ? model.clusterRanges : [
            { min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 },
        ]);
        setShowForm(true);
    };

    useEffect(() => {
        if (formKind !== 'clustering') return;
        setFormClusterRanges(prev => prev.length === 3 ? prev : [
            { min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 },
        ]);
    }, [formKind]);

    const formComponentTarget = formKind === 'clustering' ? formY : formTarget;
    const formComponent = formComponentTarget ? getComponent(formComponentTarget) : '';

    const formValid = formName.trim() !== '' && formKind !== null && formCategory !== null && (
        formKind === 'individual' ? formTarget !== '' :
        formKind === 'relationship' ? formTarget !== '' && formPredictors.length >= 1 :
        formKind === 'clustering' ? formX !== '' && formY !== '' && (!formCriteria || formClusterRanges.every(r => r.min !== null && r.max !== null)) :
        false
    );

    const commitForm = () => {
        if (!formValid || !formKind || !formCategory) return;
        const fields = {
            name: formName.trim(),
            kind: formKind,
            category: formCategory,
            targetSensor: formKind === 'clustering' ? '' : formTarget,
            predictorSensors: formKind === 'relationship' ? formPredictors : [],
            xSensor: formKind === 'clustering' ? formX : '',
            ySensor: formKind === 'clustering' ? formY : '',
            criteriaSensor: formKind === 'clustering' ? formCriteria : '',
            clusterRanges: formKind === 'clustering' && formCriteria ? formClusterRanges : [],
        };
        if (editingModelId) {
            persist((models, groups) => ({
                groups,
                models: models.map(m => m.id === editingModelId ? { ...m, ...fields } : m),
            }));
        } else {
            const model: FailureModel = { ...makeDefaultModel(groupNo), ...fields };
            persist((models, groups) => ({ groups, models: [...models, model] }));
        }
        resetForm();
    };

    const toggleModelStatus = (modelId: string) => {
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: !m.status } : m),
        }));
    };

    const removeModel = () => {
        if (!editingModelId) return;
        const current = groupModels.find(m => m.id === editingModelId);
        if (!confirm(`Remove model "${current?.name || 'Untitled'}"?`)) return;
        persist((models, groups) => ({ groups, models: models.filter(m => m.id !== editingModelId) }));
        resetForm();
    };

    const trainModel = (modelId: string) => {
        emit('launch-predictive-model', { modelId });
    };

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    if (loading || !group) {
        return <div style={{ background: 'var(--bg-primary)', height: '100vh' }} />;
    }

    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Build Model — FG-{groupNo} · {group.name}
                </h2>
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Left: group meta */}
                <div className="flex flex-col shrink-0 overflow-y-auto" style={{ width: '300px', borderRight: '1px solid var(--border)', padding: '16px', gap: '14px', display: 'flex' }}>
                    <div>
                        <div style={{ fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)', marginBottom: '4px' }}>Failure Group ID</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>FG-{groupNo}</div>
                    </div>
                    <div>
                        <div style={{ fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)', marginBottom: '4px' }}>Name</div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{group.name}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Description</label>
                        <textarea
                            rows={4}
                            value={descDraft}
                            placeholder="What failure mode does this group track?"
                            onChange={e => setDescDraft(e.target.value)}
                            style={{ resize: 'vertical', padding: '6px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.78rem' }}
                        />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Recommendation</label>
                        <textarea
                            rows={4}
                            value={recDraft}
                            placeholder="Recommended action when this failure is detected"
                            onChange={e => setRecDraft(e.target.value)}
                            style={{ resize: 'vertical', padding: '6px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.78rem' }}
                        />
                    </div>
                </div>

                {/* Right: models */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Models in this group</span>
                        <span style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>{groupModels.length} model{groupModels.length === 1 ? '' : 's'}</span>
                    </div>

                    <div className="flex-1 overflow-y-auto" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {groupModels.map(model => {
                            const targetTag = model.kind === 'clustering' ? model.ySensor : model.targetSensor;
                            const component = targetTag ? getComponent(targetTag) : '';
                            return (
                                <div
                                    key={model.id}
                                    onClick={() => openEditForm(model)}
                                    style={{ cursor: 'pointer', border: '1px solid var(--border)', borderRadius: '10px', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '12px' }}
                                >
                                    <div className="model-kind-icon">{KIND_ABBREV[model.kind]}</div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', marginBottom: '3px' }}>
                                            <span style={{ fontSize: '0.86rem', fontWeight: 600 }}>{model.name || 'Untitled model'}</span>
                                            {model.category && (
                                                <span className={`model-chip model-chip--${model.category === 'performance' ? 'perf' : 'cond'}`}>
                                                    {CATEGORY_LABELS[model.category]}
                                                </span>
                                            )}
                                            {component && <span className="model-chip model-chip--component">{component}</span>}
                                        </div>
                                        <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {sensorSummary(model)}
                                        </div>
                                    </div>
                                    <button
                                        className={`fg-status-pill fg-status-pill--${model.status ? 'ok' : 'neutral'}`}
                                        onClick={e => { e.stopPropagation(); toggleModelStatus(model.id); }}
                                        style={{ cursor: 'pointer', flexShrink: 0 }}
                                    >
                                        {model.status ? 'Complete' : 'Incomplete'}
                                    </button>
                                    <button
                                        className="fg-build-model-btn"
                                        onClick={e => { e.stopPropagation(); trainModel(model.id); }}
                                        style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                                    >
                                        Open in Predictive Model →
                                    </button>
                                </div>
                            );
                        })}
                        {groupModels.length === 0 && !showForm && (
                            <div className="no-results">No models yet</div>
                        )}

                        {showForm ? (
                            <div data-testid="add-model-form" style={{ border: '1px solid var(--border-strong, var(--border))', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <div className="fg-inspector-field">
                                    <div className="fg-inspector-field-label-row"><label>Model name</label></div>
                                    <input
                                        className="fg-inspector-input"
                                        value={formName}
                                        placeholder="e.g. Bearing vibration model"
                                        onChange={e => setFormName(e.target.value)}
                                    />
                                </div>

                                <div>
                                    <div className="fg-inspector-field-label-row" style={{ marginBottom: '4px' }}><label>Model kind</label></div>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        {(['individual', 'relationship', 'clustering'] as ModelKind[]).map(k => (
                                            <button
                                                key={k}
                                                onClick={() => setFormKind(k)}
                                                style={{
                                                    flex: 1, padding: '6px 4px', borderRadius: '6px', fontSize: '0.72rem', cursor: 'pointer',
                                                    border: `1px solid ${formKind === k ? 'var(--accent-color)' : 'var(--border)'}`,
                                                    background: formKind === k ? 'var(--accent-muted)' : 'none',
                                                    color: formKind === k ? 'var(--accent-color)' : 'var(--text-secondary)',
                                                    fontWeight: formKind === k ? 600 : 400,
                                                }}
                                            >
                                                {KIND_LABELS[k]}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <div className="fg-inspector-field-label-row" style={{ marginBottom: '4px' }}><label>Category</label></div>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        {(['performance', 'condition'] as ModelCategory[]).map(c => (
                                            <button
                                                key={c}
                                                onClick={() => setFormCategory(c)}
                                                style={{
                                                    flex: 1, padding: '6px 4px', borderRadius: '6px', fontSize: '0.72rem', cursor: 'pointer',
                                                    border: `1px solid ${formCategory === c ? 'var(--accent-color)' : 'var(--border)'}`,
                                                    background: formCategory === c ? 'var(--accent-muted)' : 'none',
                                                    color: formCategory === c ? 'var(--accent-color)' : 'var(--text-secondary)',
                                                    fontWeight: formCategory === c ? 600 : 400,
                                                }}
                                            >
                                                {CATEGORY_LABELS[c]}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {formKind === 'individual' && (
                                    <div className="fg-inspector-field">
                                        <div className="fg-inspector-field-label-row"><label>Target sensor</label></div>
                                        <select className="fg-inspector-input" value={formTarget} onChange={e => setFormTarget(e.target.value)}>
                                            <option value="">Select a sensor…</option>
                                            {allSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </div>
                                )}

                                {formKind === 'relationship' && (
                                    <>
                                        <div className="fg-inspector-field">
                                            <div className="fg-inspector-field-label-row"><label>Target sensor</label></div>
                                            <select className="fg-inspector-input" value={formTarget} onChange={e => setFormTarget(e.target.value)}>
                                                <option value="">Select a sensor…</option>
                                                {allSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </div>
                                        <div className="fg-inspector-field">
                                            <div className="fg-inspector-field-label-row"><label>Predictor sensors (≥ 1)</label></div>
                                            <select
                                                className="fg-inspector-input"
                                                value=""
                                                onChange={e => { if (e.target.value) setFormPredictors(prev => prev.includes(e.target.value) ? prev : [...prev, e.target.value]); }}
                                            >
                                                <option value="">Add a predictor…</option>
                                                {allSensors.filter(s => s !== formTarget && !formPredictors.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                            {formPredictors.length > 0 && (
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                                                    {formPredictors.map(p => (
                                                        <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.68rem', padding: '2px 6px', borderRadius: '999px', background: 'var(--chip-bg)', border: '1px solid var(--border)' }}>
                                                            {p}
                                                            <button onClick={() => setFormPredictors(prev => prev.filter(x => x !== p))} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex' }}>
                                                                <X size={9} />
                                                            </button>
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}

                                {formKind === 'clustering' && (
                                    <>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            <div className="fg-inspector-field" style={{ flex: 1 }}>
                                                <div className="fg-inspector-field-label-row"><label>X sensor</label></div>
                                                <select className="fg-inspector-input" value={formX} onChange={e => setFormX(e.target.value)}>
                                                    <option value="">Select…</option>
                                                    {allSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                                </select>
                                            </div>
                                            <div className="fg-inspector-field" style={{ flex: 1 }}>
                                                <div className="fg-inspector-field-label-row"><label>Y sensor</label></div>
                                                <select className="fg-inspector-input" value={formY} onChange={e => setFormY(e.target.value)}>
                                                    <option value="">Select…</option>
                                                    {allSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                        <div className="fg-inspector-field">
                                            <div className="fg-inspector-field-label-row"><label>Criteria sensor (optional)</label></div>
                                            <select className="fg-inspector-input" value={formCriteria} onChange={e => setFormCriteria(e.target.value)}>
                                                <option value="">None</option>
                                                {allSensors.map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </div>
                                        {formCriteria && (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                <div className="fg-inspector-field-label-row"><label>Cluster ranges</label></div>
                                                {formClusterRanges.map((r, i) => (
                                                    <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                                        <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', width: '16px' }}>{i + 1}</span>
                                                        <input
                                                            type="number"
                                                            className="fg-inspector-input"
                                                            value={r.min ?? ''}
                                                            placeholder="min"
                                                            onChange={e => setFormClusterRanges(prev => prev.map((row, idx) => idx === i ? { ...row, min: e.target.value === '' ? null : Number(e.target.value) } : row))}
                                                        />
                                                        <input
                                                            type="number"
                                                            className="fg-inspector-input"
                                                            value={r.max ?? ''}
                                                            placeholder="max"
                                                            onChange={e => setFormClusterRanges(prev => prev.map((row, idx) => idx === i ? { ...row, max: e.target.value === '' ? null : Number(e.target.value) } : row))}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </>
                                )}

                                {formComponentTarget && formComponent && (
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        Component <ChevronRight size={11} /> <b style={{ color: 'var(--text-primary)' }}>{formComponent}</b>
                                    </div>
                                )}

                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                                    {editingModelId && (
                                        <button className="text-btn" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={removeModel}>
                                            Remove model
                                        </button>
                                    )}
                                    <button className="text-btn" onClick={resetForm}>Cancel</button>
                                    <button className="fg-build-model-btn" disabled={!formValid} onClick={commitForm}>
                                        {editingModelId ? 'Save changes' : 'Create model'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={openAddForm}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '9px 0', borderRadius: '8px', border: '1px dashed var(--border)', background: 'none', color: 'var(--text-secondary)', fontSize: '0.75rem', cursor: 'pointer' }}
                            >
                                <Plus size={14} /> Add Model
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
