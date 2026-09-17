import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { X, Plus, ChevronDown, Gauge } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter } from "../../types";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import PredictiveModelBuild, { SensorAutocomplete } from "./PredictiveModelBuild";

interface BuildModelData {
    workspaceId: string;
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
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

// Same oklch values as .fg-group-color-{name} in App.css, kept as plain JS
// here rather than relied on via CSS inheritance — a Component-view row's
// accordion isn't nested inside a `.fg-group-color-*` element at all. Ties
// an open row/form back to its own group's color (a thin left accent bar)
// plus a small text breadcrumb inside the form itself, so it's always
// obvious which model's detail is on screen — per explicit user request,
// a second time, now that the layout/scroll bugs that made an earlier
// version of this feel cluttered are actually fixed.
const FG_ACCENT: Record<string, string> = {
    amber: 'oklch(0.78 0.14 75)',
    violet: 'oklch(0.7 0.15 310)',
    green: 'oklch(0.72 0.15 150)',
    blue: 'oklch(0.68 0.17 245)',
    slate: 'var(--text-faint)',
};

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

type GroupBy = 'fg' | 'component' | 'kind';

// Fixed order (not alphabetical) -- I/R/C is a small, natural taxonomy, not
// an open-ended list like components, so it reads better presented in the
// same order the kind toggles/badges use everywhere else in the app.
const KIND_ORDER: ModelKind[] = ['individual', 'relationship', 'clustering'];
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

/**
 * The single Build Model window — a singleton (label `build-model`) opened
 * from the Failure Groups tab's "Build Model" button. One page only —
 * every model from every Failure Group, groupable by FG or by Component —
 * with everything editable inline, no navigation to a second page at all
 * (an earlier version of this redesign used a separate "model detail"
 * page; the user asked for that to become an inline accordion instead):
 *
 *   - Clicking a model row (FG or Component view) expands that model's
 *     edit form directly beneath the row, accordion-style — clicking it
 *     again (or a different row) closes/switches it. This replaces an
 *     earlier version that navigated to a dedicated model page; the user
 *     asked for it to work like the old per-group window's inline row
 *     editing instead: "it should become a tab appearing below that
 *     model, not go to a new page".
 *   - 2026-08-31: there is no "add" flow anymore — toggling a sensor into
 *     a group (Sensor tab) is the sole way a model comes into existence
 *     now, always as kind 'individual'; this window only ever edits an
 *     existing model's detail afterward, per explicit user request
 *     ("เอาปุ่ม add model ออกเหมือนกัน ของหน้านี้").
 *   - 2026-08-31: a Failure Group's own Name/Description/Recommendation
 *     are no longer editable here at all — that "Edit details" panel
 *     moved to Dashboard's Failure Groups tab entirely (not duplicated),
 *     per explicit user request ("ส่วนของ edit detail ต้องอยู่ที่
 *     dashboard ด้วย"). This window's group cards are read-only headers
 *     now — name, FG badge, model count — nothing else to edit about the
 *     group itself.
 *   - 2026-09-01: a model's own "Failure groups" list in the edit form is
 *     now read-only too (a plain chip list, no checkboxes) — membership is
 *     changed exclusively via the Sensor tab's per-kind toggle, per
 *     explicit user request ("ไม่ควรแก้ FG ได้ในหน้านี้ ดูได้อย่างเดียว
 *     ไปแก้ที่หน้า dashboard ที่ทำไว้แล้ว").
 *   - 2026-09-01: each kind's auto-filled "identity" sensor — Individual/
 *     Relationship's Target, Clustering's X — is locked (read-only) once
 *     set, so it can't be changed by mistake after the model already
 *     exists; Relationship's predictors and Clustering's Y sensor stay
 *     freely editable, per explicit user request ("sensor ที่เป็น auto
 *     fill ... ต้องล็อคไว้ห้าม user เปลี่ยน ... ส่วน predictor ของ relation
 *     กับ y sensor ของ clustering สามารถเปลี่ยนได้").
 *   - 2026-09-01 (later): the "Model kind" picker itself is gone too — a
 *     model's kind is decided once, on the Sensor tab (which I/R/C toggle
 *     created it), and can no longer be switched afterward here, per
 *     explicit user request ("ลบการเปลี่ยน model kind ออก เพราะว่าเราเลือก
 *     model kind ที่หน้า dashboard แล้ว"). `formKind` still exists as
 *     state (seeded from the model being edited) purely to pick which
 *     kind-specific fields render below — it's fixed for the life of the
 *     form.
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
    // Workspace-wide "machine running" filter (2026-09-15) — the whole point
    // of this panel living on the Overview page rather than per-model: set
    // once here, every model of every kind picks it up automatically at
    // train time (see PredictiveModelBuild.tsx's `dashboardFilterPayload`).
    // Replaced the old per-model `pmSensorFilters` — with 100 models in one
    // workspace, setting the same "is the machine running" condition 100
    // times separately was the actual problem being solved.
    const [runningConditionFilters, setRunningConditionFilters] = useState<WorkspaceSensorFilter[]>([]);
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    const [groupBy, setGroupBy] = useState<GroupBy>('fg');

    // ---- Predictive Model page — an in-window "next page" (not a spawned
    //      OS window) reached from the model edit form's "Build Model"
    //      button (see `renderModelFormFooter`). Only
    //      Dashboard + this singleton window are ever open at once; PM used
    //      to be its own window/label ('predictive-model') until the user
    //      asked for it to become a page inside this one instead, same
    //      consolidation this window itself already went through (see this
    //      component's own doc comment above). ----
    const [activePage, setActivePage] = useState<'overview' | 'model'>('overview');
    const [pmPageModelId, setPmPageModelId] = useState<string | null>(null);


    // ---- Model edit accordion: one form active at a time, shown
    //      directly under the row that opened it ----
    const [showForm, setShowForm] = useState(false);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    /** Which group(s) the form's model will belong to — a checkbox
     *  multi-select (2026-08-25: one model can belong to several Failure
     *  Groups at once, per explicit user request). */
    const [formGroupNos, setFormGroupNos] = useState<number[]>([]);
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
    // Raw description only (not the "description (tag)" combo `sensorLabel`
    // below builds) — matches `SensorAutocomplete`'s own `getDesc` contract,
    // which appends the tag itself separately.
    const getDesc = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description ?? '', [sensorMetaMap]);
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
    // Clustering's Y sensor stays blank until configured (see this file's
    // own doc comment on "auto-fill sensor" locking below) — falling back
    // to X keeps a fresh Clustering model's label/component the same as
    // Individual/Relationship's instead of reading "Untitled"/Uncategorized
    // until someone happens to fill in Y, which the user flagged as an
    // inconsistency between the Dashboard's own FG tab and here (both
    // derive from the same target-tag shape).
    const modelDisplayLabel = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const trimmedName = model.name.trim();
        if (trimmedName && trimmedName !== targetTag) return trimmedName;
        if (!targetTag) return 'Untitled model';
        return sensorLabel(targetTag);
    }, [sensorLabel]);

    const modelComponent = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        if (!targetTag) return UNCATEGORIZED;
        return sensorMetaMap.get(normalizeSensorTag(targetTag))?.component || UNCATEGORIZED;
    }, [sensorMetaMap]);

    useEffect(() => {
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
                    setRunningConditionFilters(ws?.failureGroupState?.runningConditionFilters ?? []);
                } catch (e) {
                    console.warn('Failed to hydrate failure-group state:', e);
                }
                hydratedRef.current = true;
                setLoading(false);
            });

            // Any other window (Dashboard, PredictiveModelBuild) that
            // persists failureGroupState broadcasts this so our copy never
            // goes stale.
            unlistenChanged = await listen<{ groups: FailureGroup[]; models: FailureModel[]; runningConditionFilters?: WorkspaceSensorFilter[] }>('failure-group-state-changed', (event) => {
                setAllGroups(event.payload.groups);
                setAllModels(event.payload.models);
                setRunningConditionFilters(event.payload.runningConditionFilters ?? []);
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
            return {
                ...prev,
                failureGroupState: {
                    groups: result.groups,
                    models: result.models,
                    // This path never touches the running-condition filter —
                    // preserve whatever is on disk right now (see
                    // persistRunningConditionFilters below for the one path
                    // that does change it).
                    runningConditionFilters: prev.failureGroupState?.runningConditionFilters ?? [],
                },
            };
        });
        if (next?.failureGroupState) {
            setAllGroups(next.failureGroupState.groups);
            setAllModels(next.failureGroupState.models);
            setRunningConditionFilters(next.failureGroupState.runningConditionFilters ?? []);
            await emit('failure-group-state-changed', next.failureGroupState);
        }
    }, [workspaceId]);

    // The one path that actually changes the running-condition filter —
    // edited entirely from this window's own "Running Condition Filter"
    // panel (see the JSX below), never per-model.
    const persistRunningConditionFilters = useCallback(async (filters: WorkspaceSensorFilter[]) => {
        if (!workspaceId) return;
        const next = await updateWorkspaceData(workspaceId, prev => ({
            ...prev,
            failureGroupState: {
                groups: prev.failureGroupState?.groups ?? [],
                models: prev.failureGroupState?.models ?? [],
                runningConditionFilters: filters,
            },
        }));
        if (next?.failureGroupState) {
            setAllGroups(next.failureGroupState.groups);
            setAllModels(next.failureGroupState.models);
            setRunningConditionFilters(next.failureGroupState.runningConditionFilters ?? []);
            await emit('failure-group-state-changed', next.failureGroupState);
        }
    }, [workspaceId]);

    const addRunningConditionFilter = useCallback(() => {
        const next = [...runningConditionFilters, {
            id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sensor: allSensors[0] ?? '',
            operation: 'greater_than' as const,
            value1: '',
            value2: '',
        }];
        setRunningConditionFilters(next);
        persistRunningConditionFilters(next);
    }, [runningConditionFilters, allSensors, persistRunningConditionFilters]);

    const updateRunningConditionFilter = useCallback((id: string, patch: Partial<WorkspaceSensorFilter>) => {
        const next = runningConditionFilters.map(f => f.id === id ? { ...f, ...patch } : f);
        setRunningConditionFilters(next);
        persistRunningConditionFilters(next);
    }, [runningConditionFilters, persistRunningConditionFilters]);

    const removeRunningConditionFilter = useCallback((id: string) => {
        const next = runningConditionFilters.filter(f => f.id !== id);
        setRunningConditionFilters(next);
        persistRunningConditionFilters(next);
    }, [runningConditionFilters, persistRunningConditionFilters]);

    // ---- Model edit accordion — 2026-08-31: "add" removed entirely per
    //      explicit user request; toggling a sensor into a group (Sensor
    //      tab) is now the sole way a model comes into existence, always
    //      as kind 'individual'. This form only ever edits an existing
    //      model afterward — including changing its kind to relationship/
    //      clustering, which stays fully supported here. ----
    const resetForm = () => {
        setEditingModelId(null);
        setFormGroupNos([]);
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

    const openEditForm = (model: FailureModel) => {
        setEditingModelId(model.id);
        setFormGroupNos(model.groupNos);
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

    const formValid = formName.trim() !== '' && formKind !== null && formCategory !== null && formGroupNos.length > 0 && (
        formKind === 'individual' ? formTarget !== '' :
        formKind === 'relationship' ? formTarget !== '' && formPredictors.length >= 1 :
        formKind === 'clustering' ? formX !== '' && formY !== '' && (!formCriteria || formClusterRanges.every(r => r.min !== null && r.max !== null)) :
        false
    );

    const commitForm = () => {
        if (!formValid || !formKind || !formCategory || !editingModelId) return;
        const fields = {
            groupNos: formGroupNos,
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
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === editingModelId ? { ...m, ...fields } : m),
        }));
        resetForm();
    };

    const toggleModelStatus = (modelId: string) => {
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: !m.status } : m),
        }));
    };

    /** Sets `status: true` unconditionally (unlike `toggleModelStatus`) —
     *  used by the PM page's "Finish" button, where clicking it again should
     *  never accidentally flip an already-complete model back to
     *  incomplete. Un-marking a model still goes through the overview's own
     *  status pill (`toggleModelStatus`). */
    const markModelComplete = (modelId: string) => {
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: true } : m),
        }));
    };

    const trainModel = (modelId: string) => {
        setPmPageModelId(modelId);
        setActivePage('model');
    };

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    // Split into fields (own bounded, independently-scrollable box) + a
    // footer (Save changes) that is never inside that box — a tall form
    // (e.g. Relationship kind with several fields) used to be one long
    // flow relying on the whole page's scroll position to reach its own
    // button, which repeatedly left it unreachable or looking "missing"
    // depending on exactly where the page happened to be scrolled. The
    // footer is now structurally always rendered directly under the
    // fields box, at a fixed, predictable position, regardless of how
    // tall the fields are or how the surrounding list is scrolled.
    const renderModelFormFields = () => {
        // 2026-08-31: add-mode removed entirely — this form only ever
        // edits an existing model now, so the sensor list is always
        // unrestricted (the model's own target/group is already
        // established and may legitimately need any sensor).
        const sensorOptions = allSensors;
        return (
        <div data-testid="add-model-form-fields" style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '48vh', overflowY: 'auto', padding: '12px 14px' }}>
            <div className="fg-inspector-field">
                <div className="fg-inspector-field-label-row"><label>Model name</label></div>
                <input
                    className="fg-inspector-input"
                    value={formName}
                    placeholder="e.g. Bearing vibration model"
                    onChange={e => setFormName(e.target.value)}
                />
            </div>

            {/* Read-only — 2026-09-01: group membership stopped being
                editable here per explicit user request ("ไม่ควรแก้ FG ได้
                ในหน้านี้ ดูได้อย่างเดียว ไปแก้ที่หน้า dashboard ที่ทำไว้แล้ว");
                it's changed exclusively via the Sensor tab's per-kind
                toggle now (see Dashboard.tsx's toggleSensorGroupKind), same
                place that creates/removes a model altogether. This just
                shows where the model currently sits. */}
            <div>
                <div className="fg-inspector-field-label-row" style={{ marginBottom: '4px' }}><label>Failure groups</label></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {formGroupNos.map(no => {
                        const g = realGroups.find(x => x.no === no);
                        return (
                            <span key={no} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.72rem', padding: '3px 8px', borderRadius: '999px', background: 'var(--chip-bg)', border: '1px solid var(--border)' }}>
                                <span style={{ width: '6px', height: '6px', borderRadius: '2px', background: FG_ACCENT[getFgGroupColor(no)], flexShrink: 0 }} />
                                {no === 0 ? 'Not in Group' : `FG-${no} · ${g?.name ?? ''}`}
                            </span>
                        );
                    })}
                </div>
                <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '4px' }}>
                    Managed from the Dashboard's Sensor tab.
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
                    <div className="model-component-readout">{formTarget ? sensorLabel(formTarget) : '—'}</div>
                    <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '3px' }}>Locked — set when the model was created, to prevent picking the wrong sensor by mistake.</div>
                </div>
            )}

            {formKind === 'relationship' && (
                <>
                    <div className="fg-inspector-field">
                        <div className="fg-inspector-field-label-row"><label>Target sensor</label></div>
                        <div className="model-component-readout">{formTarget ? sensorLabel(formTarget) : '—'}</div>
                        <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '3px' }}>Locked — set when the model was created, to prevent picking the wrong sensor by mistake.</div>
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
                            <div className="model-component-readout">{formX ? sensorLabel(formX) : '—'}</div>
                            <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '3px' }}>Locked — set when the model was created.</div>
                        </div>
                        <div className="fg-inspector-field" style={{ flex: 1 }}>
                            <div className="fg-inspector-field-label-row"><label>Y sensor (target)</label></div>
                            <select className="fg-inspector-input" value={formY} onChange={e => setFormY(e.target.value)}>
                                <option value="">Select…</option>
                                {sensorOptions.map(s => <option key={s} value={s}>{sensorLabel(s)}</option>)}
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
        </div>
        );
    };

    // No "Cancel" button — closing the form is already just re-clicking
    // whatever opened it (the model row), same toggle everywhere, per
    // explicit user feedback that a separate Cancel was redundant with
    // that. `.fg-build-model-btn` defaults to `width: 100%` for its other
    // use as a standalone full-width panel button, so it's explicitly
    // sized here instead of left to stretch across the whole row.
    //
    // 2026-08-31: this form only ever edits an existing model now (add
    // removed entirely), so `editingModelId` is always set whenever the
    // form is open — footer no longer branches on it. No "Remove model"
    // button either — model deletion moved to Dashboard's Failure Groups
    // tab (a trash icon per model row there), per explicit user request
    // that Build Model do only detail-editing and training, nothing else.
    //
    // 2026-09-09: "Build Model →" moved here from the (always-visible)
    // row header, right after Save changes, per explicit user request
    // (screenshot) — training an incomplete model didn't make sense, so
    // it's disabled on the same `formValid` gate Save changes already
    // uses, and only reachable once the row is open for review anyway.
    // Clicking it commits the current draft first (same as Save changes)
    // before navigating — without that, editing a field and clicking
    // Build Model straight away (without an intervening Save click) would
    // silently train on the OLD persisted values while the screen still
    // showed the new ones.
    //
    // `position: sticky, bottom: 0` — being structurally right after the
    // fields box (rather than, say, inside a page-level modal) turned out
    // not to be enough: a group deep in a long list, or a form long enough
    // to fill the fields box's own max-height, could still place this
    // footer's natural position below the currently-visible viewport, with
    // no indication it existed at all. Sticky pins it to the bottom of the
    // visible area the instant the form opens, regardless of where the
    // page happens to be scrolled or how tall the fields above it are —
    // it only lets go once the whole accordion block scrolls out of view.
    // Requires no `overflow: hidden` on any ancestor between this and the
    // page's own scroll container (see the group card wrappers above).
    const buildModelFromForm = () => {
        if (!formValid || !editingModelId) return;
        const modelId = editingModelId;
        commitForm();
        trainModel(modelId);
    };

    const renderModelFormFooter = () => (
        // Bottom corners rounded to match the editing card's own
        // `borderRadius: '10px'` (see `overviewModelRow`'s accent-bordered
        // wrapper) — that wrapper deliberately has no `overflow: hidden`
        // (see its own comment: clipping would break this footer's
        // stickiness), so without matching corners here, this footer's
        // flat, opaque (`--card-bg`) rectangle visually paints straight
        // over the parent's rounded bottom corners once it settles at the
        // bottom of the scroll — reading as the accent border simply not
        // connecting there (reported 2026-09-17).
        <div style={{ position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--card-bg)', borderBottomLeftRadius: '10px', borderBottomRightRadius: '10px' }}>
            <button className="fg-build-model-btn" style={{ width: 'auto', padding: '8px 22px' }} disabled={!formValid} onClick={commitForm}>
                Save changes
            </button>
            <button
                className="model-open-pm"
                disabled={!formValid}
                title={formValid ? undefined : 'Fill in the required fields above first'}
                onClick={buildModelFromForm}
            >
                Build Model →
            </button>
        </div>
    );

    // Both halves together — fields in their own bounded, independently
    // scrollable box, footer always visible directly beneath it.
    const renderModelForm = () => (
        <div data-testid="add-model-form">
            {renderModelFormFields()}
            {renderModelFormFooter()}
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
    const kindSections = (() => {
        const byKind = new Map<ModelKind, FailureModel[]>();
        for (const m of allModels) {
            if (!byKind.has(m.kind)) byKind.set(m.kind, []);
            byKind.get(m.kind)!.push(m);
        }
        return KIND_ORDER
            .filter(k => byKind.has(k))
            .map((k): [ModelKind, FailureModel[]] => [k, byKind.get(k)!]);
    })();

    // One row per model, with its own add/edit form directly beneath it
    // when active (accordion) — used by both the FG-grouped and
    // Component-grouped views.
    const overviewModelRow = (model: FailureModel, showFgTag: boolean) => {
        // A model can belong to several groups now — the chip lists all of
        // them (comma-separated), and the accordion's own accent border
        // just picks the FIRST one as its primary color rather than trying
        // to blend several.
        const groupTags = model.groupNos.map(no => {
            const grp = allGroups.find(x => x.no === no);
            return no === 0 ? 'Not in Group' : `FG-${no}${grp ? ` · ${grp.name}` : ''}`;
        }).join(', ');
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const component = targetTag ? getComponent(targetTag) : '';
        const isEditingThis = showForm && editingModelId === model.id;
        const accent = FG_ACCENT[getFgGroupColor(model.groupNos[0] ?? 0)];
        return (
            <div key={model.id} style={{ borderTop: '1px solid var(--border)' }}>
                {/* A real border (not an absolutely-positioned left bar) so the
                    boundary always encloses the sticky footer too — a sticky
                    element can never paint outside its own parent's box, but an
                    absolute-positioned bar is anchored to the row's un-scrolled
                    flow position and visibly detaches from the footer once the
                    page scrolls (the report that prompted this). */}
                <div style={isEditingThis ? { border: `1.5px solid ${accent}`, borderRadius: '10px', margin: '6px 8px' } : undefined}>
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
                                        {groupTags}
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
                    </div>
                    {isEditingThis && (
                        <div style={{ borderTop: '1px solid var(--border)' }}>
                            {renderModelForm()}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const pmPageModel = activePage === 'model' ? allModels.find(m => m.id === pmPageModelId) : undefined;

    return (
        // Matches the Dashboard's own card surfaces (`.widget-section`/
        // `.chart-section-large`, which use `--card-bg`) rather than
        // `--bg-primary` — this window's content (the Failure Groups list)
        // is the same content as the Dashboard's own Failure Groups card, so
        // it should read as the same surface tone, not the page canvas one.
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {pmPageModel ? `Build Model — ${modelDisplayLabel(pmPageModel)}` : 'Build Model — Overview'}
                </h2>
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            {pmPageModel && workspaceId ? (
                <PredictiveModelBuild
                    workspaceId={workspaceId}
                    modelId={pmPageModel.id}
                    kind={pmPageModel.kind}
                    sensorHeaders={allSensors}
                    sensorMetadata={sensorMetadata}
                    runningConditionFilters={runningConditionFilters}
                    onBack={() => setActivePage('overview')}
                    onFinish={() => {
                        markModelComplete(pmPageModel.id);
                        setActivePage('overview');
                    }}
                />
            ) : (
            <>
            {/* Running Condition Filter — workspace-wide, set once here so
                every model of every kind picks it up automatically at train
                time instead of each needing its own "is the machine
                running" filter (2026-09-15 — replaces the old per-model
                Sensor value filter on PredictiveModelBuild.tsx). */}
            <div style={{ margin: '12px 20px 0', border: `1px solid ${runningConditionFilters.length > 0 ? 'rgba(59,130,246,0.35)' : 'var(--border)'}`, borderRadius: '10px', background: 'var(--input-bg)' }}>
                <div
                    onClick={() => setRcFilterOpen(o => !o)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '10px 14px', cursor: 'pointer', userSelect: 'none' }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <div style={{ width: 26, height: 26, borderRadius: 7, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <Gauge size={15} color="var(--accent-color)" />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>Running Condition Filter</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {runningConditionFilters.length === 0
                                    ? 'Not set — every model trains on the full dataset, including idle periods.'
                                    : runningConditionFilters.map(f => `${getDesc(f.sensor) || f.sensor} ${f.operation === 'greater_than' ? '>' : f.operation === 'less_than' ? '<' : f.operation === 'between' ? 'between' : '='} ${f.operation === 'between' ? `${f.value1}–${f.value2}` : f.value1}`).join(' AND ')}
                            </div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                        {runningConditionFilters.length > 0 && (
                            <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(16,185,129,0.14)', color: '#10b981' }}>
                                ✓ applies to {totalModels} model{totalModels !== 1 ? 's' : ''}
                            </span>
                        )}
                        <ChevronDown size={14} color="var(--text-faint)" style={{ transform: rcFilterOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
                    </div>
                </div>

                {rcFilterOpen && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
                        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                            Applied before training <strong style={{ color: 'var(--text-primary)' }}>every model</strong> in this workspace, AND-combined with each model's own Time start/end. No model has its own separate value filter any more — this is the only place to set one.
                        </p>
                        {runningConditionFilters.map(f => (
                            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', marginBottom: '6px', background: 'var(--chip-bg)', border: '1px solid var(--border)', borderRadius: '6px' }}>
                                <SensorAutocomplete
                                    sensors={allSensors}
                                    getDesc={getDesc}
                                    value={f.sensor}
                                    onSelect={sensor => updateRunningConditionFilter(f.id, { sensor })}
                                    placeholder="Search sensor..."
                                    style={{ flex: 1, minWidth: 0 }}
                                />
                                <select
                                    value={f.operation}
                                    onChange={e => updateRunningConditionFilter(f.id, { operation: e.target.value as WorkspaceSensorFilter['operation'] })}
                                    style={{ padding: '4px 6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: '4px', color: 'var(--accent-color)', fontSize: '0.7rem', fontWeight: 600, outline: 'none', flexShrink: 0 }}
                                >
                                    <option value="greater_than">&gt;</option>
                                    <option value="less_than">&lt;</option>
                                    <option value="between">between</option>
                                    <option value="equals">=</option>
                                </select>
                                <input
                                    type="number"
                                    value={f.value1}
                                    onChange={e => updateRunningConditionFilter(f.id, { value1: e.target.value })}
                                    placeholder="val"
                                    style={{ width: '68px', padding: '4px 6px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.72rem', outline: 'none', flexShrink: 0 }}
                                />
                                {f.operation === 'between' && (
                                    <input
                                        type="number"
                                        value={f.value2}
                                        onChange={e => updateRunningConditionFilter(f.id, { value2: e.target.value })}
                                        placeholder="max"
                                        style={{ width: '68px', padding: '4px 6px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.72rem', outline: 'none', flexShrink: 0 }}
                                    />
                                )}
                                <button
                                    type="button"
                                    onClick={() => removeRunningConditionFilter(f.id)}
                                    title="Remove condition"
                                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '3px', display: 'flex', flexShrink: 0 }}
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={addRunningConditionFilter}
                            disabled={allSensors.length === 0}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 9px',
                                background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '4px',
                                color: 'var(--accent-color)', fontSize: '0.68rem', fontWeight: 600,
                                cursor: allSensors.length === 0 ? 'not-allowed' : 'pointer', opacity: allSensors.length === 0 ? 0.5 : 1,
                            }}
                        >
                            <Plus size={11} /> Add condition (AND)
                        </button>
                    </div>
                )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <b style={{ color: 'var(--text-primary)' }}>{totalModels}</b> models ·
                    <b style={{ color: 'var(--text-primary)' }}>{realGroups.length}</b> groups ·
                    <b style={{ color: 'var(--text-primary)' }}>{componentSections.length}</b> components
                </div>
                <div style={{ display: 'inline-flex', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: '8px', padding: '3px', gap: '2px' }}>
                    {(['fg', 'component', 'kind'] as GroupBy[]).map(mode => (
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
                            {mode === 'fg' ? 'Group by Failure Group' : mode === 'component' ? 'Group by Component' : 'Group by Model Type'}
                        </button>
                    ))}
                </div>
            </div>

            {/* `minHeight: 0` is required here — without it, a `flex: 1` item in
                a flex column defaults to `min-height: auto` and refuses to
                shrink below its own content's height, so a tall expanded
                accordion form just grows this div past the window's bottom
                edge instead of scrolling internally (the classic flexbox
                scroll-container bug). This was the real cause of the button
                row repeatedly looking "cut off" — not a width issue. */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {groupBy === 'fg' ? (
                    realGroups.length === 0 ? (
                        <div className="no-results">No failure groups yet</div>
                    ) : realGroups.map(g => {
                        const models = allModels.filter(m => m.groupNos.includes(g.no));
                        const color = getFgGroupColor(g.no);
                        // No `overflow: hidden` on the card below (despite the rounded
                        // corners) — it would clip the sticky Save footer instead
                        // of letting it stick to the viewport; nothing inside this card
                        // actually needs edge-to-edge clipping to look right without it.
                        return (
                            <div key={g.no} className={`fg-group-color-${color}`} style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                    <span className="fg-group-dot" />
                                    <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{g.name}</span>
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-faint)' }}>FG-{g.no}</span>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                                </div>

                                {models.length === 0 ? (
                                    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px 10px 18px', fontSize: '0.72rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                                ) : models.map(m => overviewModelRow(m, false))}
                            </div>
                        );
                    })
                ) : null}

                {groupBy === 'fg' && (() => {
                    // "Not in Group" (FG-0) — a permanent, non-deletable bucket for
                    // a model whose sensor doesn't belong to any failure mode.
                    // Always rendered (unlike the read-only Dashboard preview,
                    // which only shows this card once it's non-empty). No
                    // "Edit details" — it's not a real failure group, so there's
                    // no name/description/recommendation to edit.
                    const ungroupedModels = allModels.filter(m => m.groupNos.includes(0));
                    return (
                        <div className="fg-group-color-slate" style={{ border: '1px dashed var(--border)', borderRadius: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                <span className="fg-group-dot" />
                                <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1, color: 'var(--text-secondary)' }}>Not in Group</span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{ungroupedModels.length} model{ungroupedModels.length === 1 ? '' : 's'}</span>
                            </div>

                            {ungroupedModels.length === 0 ? (
                                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px 10px 18px', fontSize: '0.72rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                            ) : ungroupedModels.map(m => overviewModelRow(m, false))}
                        </div>
                    );
                })()}

                {groupBy === 'component' && (
                    componentSections.length === 0 ? (
                        <div className="no-results">No models yet</div>
                    ) : componentSections.map(([comp, models]) => {
                        const initials = comp.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                        return (
                            <div key={comp} style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
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

                {groupBy === 'kind' && (
                    kindSections.length === 0 ? (
                        <div className="no-results">No models yet</div>
                    ) : kindSections.map(([kind, models]) => (
                        <div key={kind} style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                <div className={`model-kind-icon model-kind-icon--${kind}`} style={{ width: '26px', height: '26px', fontSize: '0.68rem', flexShrink: 0 }}>
                                    {KIND_ABBREV[kind]}
                                </div>
                                <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{KIND_LABEL[kind]}</span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                            </div>
                            {models.map(m => overviewModelRow(m, true))}
                        </div>
                    ))
                )}
            </div>
            </>
            )}
        </div>
    );
}
