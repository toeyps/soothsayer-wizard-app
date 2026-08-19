import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { X, Plus, Trash2 } from "lucide-react";
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
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
    performance: 'Performance',
    condition: 'Condition',
};

const UNCATEGORIZED = 'Uncategorized';
const DEFAULT_CLUSTER_RANGES = [
    { min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 },
];

// Mirrors Dashboard.tsx's own FG_GROUP_PALETTE/getFgGroupColor exactly
// (duplicated, not imported — sub-windows don't share a components module)
// so a group renders the same color here as it does on the Dashboard tab.
const FG_GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;
const getFgGroupColor = (no: number): string =>
    no === 0 ? 'slate' : FG_GROUP_PALETTE[(no - 1) % FG_GROUP_PALETTE.length];

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
        clusterRanges: DEFAULT_CLUSTER_RANGES,
        filterTimeStart: '',
        filterTimeEnd: '',
        pmSensorFilters: [],
    };
}

// `label` renders a tag as "description (tag)" when metadata has a
// description, else the bare tag — see this component's own `sensorLabel`.
function sensorSummary(model: FailureModel, label: (tag: string) => string): string {
    if (model.kind === 'individual') return `Target: ${model.targetSensor ? label(model.targetSensor) : '—'}`;
    if (model.kind === 'relationship') {
        const predictors = (model.predictorSensors ?? []).map(label).join(', ') || '—';
        return `Target: ${model.targetSensor ? label(model.targetSensor) : '—'} · Predictors: ${predictors}`;
    }
    const criteria = model.criteriaSensor ? ` · Criteria: ${label(model.criteriaSensor)}` : '';
    return `X: ${model.xSensor ? label(model.xSensor) : '—'} · Y (target): ${model.ySensor ? label(model.ySensor) : '—'}${criteria}`;
}

type GroupBy = 'fg' | 'component';

/**
 * The single Build Model window — a singleton (label `build-model`) opened
 * from the Failure Groups tab's "Build Model" button. One page only —
 * every model from every Failure Group, groupable by FG or by Component —
 * with everything editable inline, no navigation to a second page at all
 * (an earlier version of this redesign used a separate "model detail"
 * page; the user asked for that to become an inline accordion instead,
 * same request that made a Failure Group's own Name/Description/
 * Recommendation editable in place too):
 *
 *   - FG-grouped view: each group's header has an "Edit details" toggle
 *     that reveals Name + Description + Recommendation together in one
 *     panel (previously Name was separately click-to-rename — merged per
 *     explicit user request: "the name should only be editable together
 *     with the rest of the detail, not separate from it").
 *   - Clicking a model row (FG or Component view) expands that model's
 *     add/edit form directly beneath the row, accordion-style — clicking
 *     it again (or a different row) closes/switches it. A group's
 *     "+ Add Model" opens the same form, blank, in the same spot. This
 *     replaces an earlier version that navigated to a dedicated model
 *     page; the user asked for it to work like the old per-group window's
 *     inline row editing instead: "it should become a tab appearing below
 *     that model, not go to a new page".
 *
 * All of this is local state — no window spawn for any of it — which is
 * also what makes the earlier "two Build Model windows for the same
 * group" race structurally impossible now.
 *
 * Owns `failureGroupState` jointly with Dashboard and PredictiveModelBuild —
 * every write here is a read-modify-write against the full workspace file
 * and broadcasts `failure-group-state-changed` afterward so those other
 * windows never see stale data.
 */
export default function BuildModelWindow() {
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [allGroups, setAllGroups] = useState<FailureGroup[]>([]);
    const [allModels, setAllModels] = useState<FailureModel[]>([]);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    const [groupBy, setGroupBy] = useState<GroupBy>('fg');

    // ---- Group "Edit details" panel: Name + Description + Recommendation
    //      together, one group expanded at a time ----
    const [expandedGroupNo, setExpandedGroupNo] = useState<number | null>(null);
    const [groupNameDraft, setGroupNameDraft] = useState('');
    const [groupNameError, setGroupNameError] = useState('');
    const [groupDescDraft, setGroupDescDraft] = useState('');
    const [groupRecDraft, setGroupRecDraft] = useState('');

    // ---- Model add/edit accordion: one form active at a time, shown
    //      directly under the row that opened it (or under a group's
    //      "+ Add Model" for a brand-new one) ----
    const [showForm, setShowForm] = useState(false);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [formGroupNo, setFormGroupNo] = useState<number | null>(null);
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
    // "description (tag)" everywhere a sensor is shown to the user (picker
    // options, predictor chips, the summary line) — the raw tag alone
    // (e.g. "11TE1210.PV") isn't enough to recognize a sensor by; falls
    // back to the bare tag when no mapping/description exists for it.
    const sensorLabel = useCallback((tag: string) => {
        const desc = sensorMetaMap.get(normalizeSensorTag(tag))?.description;
        return desc ? `${desc} (${tag})` : tag;
    }, [sensorMetaMap]);

    // The model's own name if the user set one — a name identical to its
    // own target tag doesn't count, since legacy-migrated models default to
    // that instead of being truly unset (see workspaceManager.ts's
    // migration shim) — else "description (tag)" for the target sensor,
    // else a placeholder.
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

            // Any other window (Dashboard, PredictiveModelBuild) that
            // persists failureGroupState broadcasts this so our copy never
            // goes stale.
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

    // ---- Group "Edit details" panel (Name + Description + Recommendation
    //      together — merged per explicit user request) ----
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

    // Debounced save, mirrors PredictiveModelBuild's own 250ms config-save
    // debounce. `toggleGroupDetails` seeds the drafts to match the group's
    // current values on expand, so this naturally no-ops until the user
    // actually changes something.
    useEffect(() => {
        if (!hydratedRef.current || expandedGroupNo === null) return;
        const g = allGroups.find(x => x.no === expandedGroupNo);
        if (!g) return;
        const trimmedName = groupNameDraft.trim();
        if (trimmedName === g.name && groupDescDraft === (g.description ?? '') && groupRecDraft === (g.recommendation ?? '')) return;
        const timer = setTimeout(() => {
            if (!trimmedName) return;
            const isDuplicate = allGroups.some(x => x.no !== expandedGroupNo && x.no !== 0 && x.name.trim().toLowerCase() === trimmedName.toLowerCase());
            if (isDuplicate) {
                setGroupNameError(`A failure group named "${trimmedName}" already exists`);
                return;
            }
            setGroupNameError('');
            persist((models, groups) => ({
                models,
                groups: groups.map(x => x.no === expandedGroupNo ? { ...x, name: trimmedName, description: groupDescDraft, recommendation: groupRecDraft } : x),
            }));
        }, 250);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupNameDraft, groupDescDraft, groupRecDraft, expandedGroupNo]);

    // ---- Model add/edit accordion ----
    const resetForm = () => {
        setEditingModelId(null);
        setFormGroupNo(null);
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

    const openAddForm = (groupNo: number) => {
        resetForm();
        setFormGroupNo(groupNo);
        setShowForm(true);
    };

    const openEditForm = (model: FailureModel) => {
        setEditingModelId(model.id);
        setFormGroupNo(model.groupNo);
        setFormName(model.name);
        setFormKind(model.kind);
        setFormCategory(model.category);
        setFormTarget(model.targetSensor ?? '');
        setFormPredictors(model.predictorSensors ?? []);
        setFormX(model.xSensor ?? '');
        setFormY(model.ySensor ?? '');
        setFormCriteria(model.criteriaSensor ?? '');
        setFormClusterRanges(model.clusterRanges?.length ? model.clusterRanges : DEFAULT_CLUSTER_RANGES);
        setShowForm(true);
    };

    useEffect(() => {
        if (formKind !== 'clustering') return;
        setFormClusterRanges(prev => prev.length === 3 ? prev : DEFAULT_CLUSTER_RANGES);
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
        if (!formValid || !formKind || !formCategory || formGroupNo === null) return;
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
            const model: FailureModel = { ...makeDefaultModel(formGroupNo), ...fields };
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
        const current = allModels.find(m => m.id === editingModelId);
        if (!confirm(`Remove model "${current ? modelDisplayLabel(current) : 'Untitled'}"?`)) return;
        persist((models, groups) => ({ groups, models: models.filter(m => m.id !== editingModelId) }));
        resetForm();
    };

    const trainModel = (modelId: string) => {
        emit('launch-predictive-model', { modelId });
    };

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    const renderModelForm = () => (
        <div data-testid="add-model-form" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
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
                    {(['performance', 'condition'] as ModelCategory[]).map(c => {
                        const active = formCategory === c;
                        const activeColor = c === 'condition' ? 'var(--cond)' : 'var(--accent-color)';
                        const activeBg = c === 'condition' ? 'var(--cond-muted)' : 'var(--accent-muted)';
                        return (
                            <button
                                key={c}
                                onClick={() => setFormCategory(c)}
                                style={{
                                    flex: 1, padding: '6px 4px', borderRadius: '6px', fontSize: '0.72rem', cursor: 'pointer',
                                    border: `1px solid ${active ? activeColor : 'var(--border)'}`,
                                    background: active ? activeBg : 'none',
                                    color: active ? activeColor : 'var(--text-secondary)',
                                    fontWeight: active ? 600 : 400,
                                }}
                            >
                                {CATEGORY_LABELS[c]}
                            </button>
                        );
                    })}
                </div>
            </div>

            {formKind === 'individual' && (
                <div className="fg-inspector-field">
                    <div className="fg-inspector-field-label-row"><label>Target sensor</label></div>
                    <select className="fg-inspector-input" value={formTarget} onChange={e => setFormTarget(e.target.value)}>
                        <option value="">Select a sensor…</option>
                        {allSensors.map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
                    </select>
                </div>
            )}

            {formKind === 'relationship' && (
                <>
                    <div className="fg-inspector-field">
                        <div className="fg-inspector-field-label-row"><label>Target sensor</label></div>
                        <select className="fg-inspector-input" value={formTarget} onChange={e => setFormTarget(e.target.value)}>
                            <option value="">Select a sensor…</option>
                            {allSensors.map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
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
                            {allSensors.filter(s => s !== formTarget && !formPredictors.includes(s)).map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
                        </select>
                        {formPredictors.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                                {formPredictors.map(p => (
                                    <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.68rem', padding: '2px 6px', borderRadius: '999px', background: 'var(--chip-bg)', border: '1px solid var(--border)' }}>
                                        {sensorLabel(p)}
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
                                {allSensors.map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
                            </select>
                        </div>
                        <div className="fg-inspector-field" style={{ flex: 1 }}>
                            <div className="fg-inspector-field-label-row"><label>Y sensor (target)</label></div>
                            <select className="fg-inspector-input" value={formY} onChange={e => setFormY(e.target.value)}>
                                <option value="">Select…</option>
                                {allSensors.map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="fg-inspector-field">
                        <div className="fg-inspector-field-label-row"><label>Criteria sensor (optional)</label></div>
                        <select className="fg-inspector-input" value={formCriteria} onChange={e => setFormCriteria(e.target.value)}>
                            <option value="">None</option>
                            {allSensors.map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
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

            {formKind && (
                <div className="fg-inspector-field">
                    <div className="fg-inspector-field-label-row"><label>Component</label></div>
                    <div className={`model-component-readout${formComponent ? '' : ' model-component-readout--placeholder'}`}>
                        {formComponent || 'Auto-filled from target sensor'}
                    </div>
                </div>
            )}

            {/* No "Cancel" button — closing the form is already just re-clicking
                whatever opened it (the model row, or "+ Add Model"), same
                toggle everywhere, per explicit user feedback that a separate
                Cancel was redundant with that. `.fg-build-model-btn` defaults
                to `width: 100%` for its other use as a standalone full-width
                panel button, so it's explicitly sized here instead of left to
                stretch across the whole row. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: editingModelId ? 'space-between' : 'flex-end', gap: '8px', marginTop: '4px' }}>
                {editingModelId && (
                    <button className="model-remove-btn" onClick={removeModel}>
                        <Trash2 size={12} /> Remove model
                    </button>
                )}
                <button className="fg-build-model-btn" style={{ width: 'auto', padding: '8px 22px' }} disabled={!formValid} onClick={commitForm}>
                    {editingModelId ? 'Save changes' : 'Create model'}
                </button>
            </div>
        </div>
    );

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
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

    // One row per model, with its own add/edit form directly beneath it
    // when active (accordion) — used by both the FG-grouped and
    // Component-grouped views.
    const overviewModelRow = (model: FailureModel, showFgTag: boolean) => {
        const g = allGroups.find(x => x.no === model.groupNo);
        const targetTag = model.kind === 'clustering' ? model.ySensor : model.targetSensor;
        const component = targetTag ? getComponent(targetTag) : '';
        const isEditingThis = showForm && editingModelId === model.id;
        return (
            <div key={model.id} style={{ borderTop: '1px solid var(--border)' }}>
                <div
                    onClick={() => { if (isEditingThis) resetForm(); else openEditForm(model); }}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px 10px 18px' }}
                >
                    <div className={`model-kind-icon model-kind-icon--${model.kind}`} style={{ width: '24px', height: '24px', fontSize: '0.62rem' }}>
                        {KIND_ABBREV[model.kind]}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '2px' }}>
                            {showFgTag && (
                                <span className="model-chip model-chip--component" style={{ fontFamily: 'var(--mono)' }}>
                                    FG-{model.groupNo}{g ? ` · ${g.name}` : ''}
                                </span>
                            )}
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{modelDisplayLabel(model)}</span>
                            {model.category && (
                                <span className={`model-chip model-chip--${model.category === 'performance' ? 'perf' : 'cond'}`}>
                                    {CATEGORY_LABELS[model.category]}
                                </span>
                            )}
                            {component && <span className="model-chip model-chip--component">{component}</span>}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {sensorSummary(model, sensorLabel)}
                        </div>
                    </div>
                    <button
                        className={`model-status-pill model-status-pill--${model.status ? 'complete' : 'incomplete'}`}
                        onClick={e => { e.stopPropagation(); toggleModelStatus(model.id); }}
                    >
                        {model.status ? 'Complete' : 'Incomplete'}
                    </button>
                    <button
                        className="model-open-pm"
                        onClick={e => { e.stopPropagation(); trainModel(model.id); }}
                    >
                        Open in Predictive Model →
                    </button>
                </div>
                {isEditingThis && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
                        {renderModelForm()}
                    </div>
                )}
            </div>
        );
    };

    return (
        // Matches the Dashboard's own card surfaces (`.widget-section`/
        // `.chart-section-large`, which use `--card-bg`) rather than
        // `--bg-primary` — this window's content (the Failure Groups list)
        // is the same content as the Dashboard's own Failure Groups card, so
        // it should read as the same surface tone, not the page canvas one.
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
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
                    ) : realGroups.map(g => {
                        const models = allModels.filter(m => m.groupNo === g.no);
                        const color = getFgGroupColor(g.no);
                        const isExpanded = expandedGroupNo === g.no;
                        const isAddingHere = showForm && editingModelId === null && formGroupNo === g.no;
                        return (
                            <div key={g.no} className={`fg-group-color-${color}`} style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                    <span className="fg-group-dot" />
                                    <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{g.name}</span>
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-faint)' }}>FG-{g.no}</span>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                                    <button className="text-btn" style={{ fontSize: '0.7rem' }} onClick={() => toggleGroupDetails(g)}>
                                        {isExpanded ? 'Hide details' : 'Edit details'}
                                    </button>
                                </div>

                                {isExpanded && (
                                    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            <label style={{ fontSize: '0.66rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Name</label>
                                            <input
                                                value={groupNameDraft}
                                                onChange={e => { setGroupNameDraft(e.target.value); setGroupNameError(''); }}
                                                style={{ padding: '6px 8px', background: 'var(--input-bg)', border: `1px solid ${groupNameError ? 'var(--danger)' : 'var(--border)'}`, borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 600 }}
                                            />
                                            {groupNameError && <div style={{ fontSize: '0.66rem', color: 'var(--danger)' }}>{groupNameError}</div>}
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            <label style={{ fontSize: '0.66rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Description</label>
                                            <textarea
                                                rows={2}
                                                value={groupDescDraft}
                                                placeholder="What failure mode does this group track?"
                                                onChange={e => setGroupDescDraft(e.target.value)}
                                                style={{ resize: 'vertical', padding: '6px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.76rem' }}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            <label style={{ fontSize: '0.66rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>Recommendation</label>
                                            <textarea
                                                rows={2}
                                                value={groupRecDraft}
                                                placeholder="Recommended action when this failure is detected"
                                                onChange={e => setGroupRecDraft(e.target.value)}
                                                style={{ resize: 'vertical', padding: '6px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.76rem' }}
                                            />
                                        </div>
                                    </div>
                                )}

                                {models.length === 0 ? (
                                    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px 10px 18px', fontSize: '0.72rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                                ) : models.map(m => overviewModelRow(m, false))}

                                {/* Stays visible (doesn't get replaced by the form) so it can
                                    also act as the close trigger — same toggle as clicking a
                                    model row again. */}
                                <button
                                    onClick={() => { if (isAddingHere) resetForm(); else openAddForm(g.no); }}
                                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '8px 0', borderTop: '1px solid var(--border)', background: 'none', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: 'pointer' }}
                                >
                                    <Plus size={12} /> Add Model
                                </button>
                                {isAddingHere && (
                                    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
                                        {renderModelForm()}
                                    </div>
                                )}
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
                                {models.map(m => overviewModelRow(m, true))}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
