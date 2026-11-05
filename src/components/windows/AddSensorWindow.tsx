import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { X, Plus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { subscribe } from "../../utils/tauriEvents";
import {
    FailureModel, FailureGroupStateChangedPayload, SensorMetadata,
    SpecialSensorRecipe, UpdateSpecialSensorPayload, WorkspaceSensorFilter,
} from "../../types";
import SensorExplorer from "./SensorExplorer";
import SpecialSensorFormulaEditor, {
    SensorFieldsCard, type FormulaEditorHandle, type FormulaEditorLock, type FormulaEditorReport,
} from "./SpecialSensorFormulaEditor";
import ManageSpecialSensors from "./ManageSpecialSensors";
import { debugLog } from "../../utils/debugLog";
import {
    buildSpecialSensorUsage, describeEditLock, findUnrestoredSpecialSensors, reorderRecipesByTags, usageFor,
    SpecialSensorUsage, UnrestoredSpecialSensors,
} from "../../utils/specialSensorDeps";
import {
    EditFailureState, EditOutcome, recipesEquivalent, runSpecialSensorEdit, SpecialSensorEditError,
} from "../../utils/specialSensorEdit";
import { demoteModelsTrainedOnSensors } from "../../utils/specialSensorRepair";
import {
    renameTagInArray, renameTagInModels, renameTagInRunningConditionFilters,
} from "../../utils/specialSensorRename";
import { nameProblem, sameTag } from "../../utils/specialSensorNaming";
import { createSerialQueue } from "../../utils/asyncQueue";
import { loadWorkspaceData } from "../../workspaceManager";
import {
    bindToGeneration, isSessionLostError, STALE_SESSION_MESSAGE, StaleSessionError, TaskAbortedError,
} from "../../utils/staleSession";
import type { Invoker } from "../../utils/specialSensorRecompute";
import { SensorMetaProvider } from '../sensor/SensorLabel';
import { buildSensorLookup, sensorPlainLabel } from '../sensor/sensorInfo';
import { PaneResizeHandle, readSavedPaneWidth } from '../PaneResizeHandle';
import {
    blockOperationConfig, editorStateFormula, editorStateToRecipe, type FormulaEditorState,
} from "../../utils/quickBuild";

/** Deleted sensor stays restorable this long; nothing has left the window until it commits. */
const UNDO_WINDOW_MS = 8000;
/** The sensor list pane (DESIGN_SYSTEM §4 rule 7): where its width is saved; it starts as the stylesheet says. */
const PANE_WIDTH_KEY = 'wizard.specialSensorPaneWidth';
const paneDefaultFor = (windowWidth: number) => (windowWidth <= 860 ? 230 : 320);

const tagKey = (tag: string) => tag.trim().toLowerCase();

/** What a rejected `invoke` carries, as text for the user. Tauri rejects with
 *  the command's `Err(String)` itself, not an `Error`. */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type ToastKind = 'ok' | 'error';

/** useState whose latest value is also readable synchronously via a ref; queued tasks need what the previous task wrote. */
function useRefState<T>(initial: T) {
    const [state, setState] = useState<T>(initial);
    const ref = useRef<T>(initial);
    const set = useCallback((update: T | ((prev: T) => T)) => {
        const next = typeof update === 'function' ? (update as (prev: T) => T)(ref.current) : update;
        ref.current = next;
        setState(next);
    }, []);
    return [state, set, ref] as const;
}

/** A deletion that has left the lists (hidden) but not yet been applied. */
interface Deletion {
    tags: string[];
    label: string;
    /** Undone before it started: it never happens. */
    cancelled: boolean;
    /** Its commit is running or finished (it can no longer be undone). */
    started: boolean;
    /** Its commit task is in the queue. */
    queued: boolean;
}

/** Form values captured at click time: the task is queued, so it must not read the form later. */
interface CreateSnapshot {
    state: FormulaEditorState;
    description: string;
    unit: string;
    component: string;
    name: string;
}

/** One Edit session; `repair` is latched at open so a no-data sensor stays unlocked if the data check briefly fails. */
interface EditSession {
    id: number;
    recipe: SpecialSensorRecipe;
    repair: { reason: string | null } | null;
}

const EMPTY_REPORT: FormulaEditorReport = { state: null, issue: null, edited: false };

/** The recipe under a new name, its calculation untouched (a rename that does not change the maths). */
function retagRecipe(recipe: SpecialSensorRecipe, tag: string): SpecialSensorRecipe {
    return recipe.kind === 'operation'
        ? { ...recipe, tag, operationConfig: { ...recipe.operationConfig, customName: tag } }
        : { ...recipe, tag };
}

/** Every special sensor built on `tag`, directly or through others (`dependentSensors` is one level). */
function transitiveDependents(usage: Map<string, SpecialSensorUsage>, tag: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([tagKey(tag)]);
    const queue = [tag];
    while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const d of usageFor(usage, cur)?.dependentSensors ?? []) {
            if (seen.has(tagKey(d))) continue;
            seen.add(tagKey(d));
            out.push(d);
            queue.push(d);
        }
    }
    return out;
}

/** The lock pill: "Used by 2 models and the running condition". */
function shortLock(usage: SpecialSensorUsage, nameOf: (tag: string) => string): string {
    const lock = usage.editLock;
    if (lock.unknown) return 'Checking what uses it';
    const models = new Set(usage.modelReferences.map(r => r.modelId)).size;
    const parts = [
        models > 0 ? `${models} model${models === 1 ? '' : 's'}` : '',
        usage.runningCondition ? 'the running condition' : '',
        lock.via.length > 0 ? lock.via.map(v => nameOf(v.tag)).join(', ') : '',
    ].filter(Boolean);
    return parts.length > 0 ? `Used by ${parts.join(' and ')}` : 'Locked';
}

/** What a queued task is bound to, captured at enqueue (refs move when the window is re-pointed). `epoch` bumps when work stops belonging here (tasks re-check after every await); `workspaceId`/`generation` tag emits and `expectedGeneration`. */
interface TaskCtx {
    epoch: number;
    workspaceId: string | undefined;
    generation: number | undefined;
}

/** One short sentence: what still uses a sensor that was about to be deleted. */
function describeUsage(usages: SpecialSensorUsage[], nameOf: (tag: string) => string): string {
    const parts: string[] = [];
    for (const u of usages) {
        if (u.dependentSensors.length > 0) parts.push(`${u.dependentSensors.map(nameOf).join(', ')} (built on it)`);
        if (u.modelReferences.length > 0) {
            parts.push(u.modelReferences.map(r => `${r.modelName || 'Untitled model'} (${r.field})`).join(', '));
        }
        if (u.runningCondition) parts.push('the workspace Running condition');
    }
    return parts.join('; ');
}

/** Special sensors with no column in the Rust session; null when the session can't say (unknown never unlocks). */
async function readUnrestored(
    inv: Invoker,
    recipes: SpecialSensorRecipe[],
    formulaRefs: Map<string, string[]> | null,
): Promise<{ result: UnrestoredSpecialSensors; columns: string[]; refs: Map<string, string[]> } | null> {
    const columns = await inv('get_all_sensors', {});
    if (!Array.isArray(columns) || columns.length === 0) return null;
    let refs = formulaRefs;
    if (!refs) {
        const formulas = recipes.filter(r => r.kind === 'formula') as Array<Extract<SpecialSensorRecipe, { kind: 'formula' }>>;
        refs = new Map();
        if (formulas.length > 0) {
            const out = await inv('extract_formula_refs', { formulas: formulas.map(r => r.formula) });
            if (!Array.isArray(out)) return null;
            formulas.forEach((r, i) => refs!.set(tagKey(r.tag), Array.isArray(out[i]) ? (out[i] as string[]) : []));
        }
    }
    const cols = columns as string[];
    return { result: findUnrestoredSpecialSensors({ recipes, sessionColumns: cols, formulaRefs: refs }), columns: cols, refs };
}

/** Why a failed replay can't be computed, via `validate_formula`; null when no specific reason. */
async function restoreReason(inv: Invoker, recipe: SpecialSensorRecipe, columns: string[], nameOf: (tag: string) => string): Promise<string | null> {
    if (recipe.kind === 'operation') {
        const have = new Set(columns.map(tagKey));
        const missing = (recipe.sourceSensors ?? []).filter(s => !have.has(tagKey(s)));
        return missing.length > 0 ? `Sensor not found: ${missing.map(nameOf).join(', ')}` : null;
    }
    try {
        const out = await inv('validate_formula', { formula: recipe.formula }) as { valid?: unknown; error?: unknown } | null;
        if (out && out.valid === false && typeof out.error === 'string' && out.error) return out.error;
    } catch (err) {
        if (isSessionLostError(err)) throw err;
    }
    return null;
}

function describeRepair(
    name: string,
    restoredDownstream: number,
    stillBroken: Array<{ tag: string; reason: string }>,
    retrainCount: number | null,
    nameOf: (tag: string) => string,
): string {
    const parts = [`Restored ${name}${restoredDownstream > 0 ? ` and ${restoredDownstream} sensor(s) built on it` : ''}.`];
    for (const b of stillBroken) parts.push(`${nameOf(b.tag)} still needs fixing: ${b.reason.replace(/[.\s]+$/, '')}.`);
    if (retrainCount === null) parts.push('Models that use it are set back to Incomplete — train them again.');
    else if (retrainCount > 0) parts.push(`${retrainCount} model(s) set back to Incomplete — train them again.`);
    return parts.join(' ');
}

export default function AddSensorWindow() {
    // State drives rendering; the ref is what tasks read (the previous task's result, never a stale render).
    const [sensors, setSensors, sensorsRef] = useRefState<string[]>([]);
    // Sensors picked for Quick build; they only drive editor options, nothing is built until committed. Cleared on Add, Edit, Clear picks.
    const [quickSel, setQuickSel] = useState<string[]>([]);
    // 0 = never moved on this PC: the stylesheet's width.
    const [paneWidth, setPaneWidth] = useState(() => readSavedPaneWidth(PANE_WIDTH_KEY, 0));
    const [paneDefaultWidth, setPaneDefaultWidth] = useState(() => paneDefaultFor(window.innerWidth));
    useEffect(() => {
        const onResize = () => setPaneDefaultWidth(paneDefaultFor(window.innerWidth));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    // What the Dashboard plotted, from `add-sensor-plot-result`; never inferred, it may refuse (Pair Plot's 4-sensor cap).
    const [plottedSensors, setPlottedSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata, sensorMetadataRef] = useRefState<SensorMetadata[] | null>(null);
    /** Description first, then tag: for toasts and errors, read when they are written. */
    const nameOf = (tag: string) => sensorPlainLabel(buildSensorLookup(null, sensorMetadataRef.current)(tag));
    const [loading, setLoading] = useState(true);
    // The sensor's own fields (Create and Edit share them; Edit seeds them).
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [unit, setUnit] = useState('');
    const [component, setComponent] = useState('');
    const [draft, setDraft] = useState<FormulaEditorReport>(EMPTY_REPORT);
    // Bump to remount the editor clean: after Add, Edit/Cancel edit, and re-point.
    const [editorKey, setEditorKey] = useState(0);
    const editorRef = useRef<FormulaEditorHandle>(null);
    // Manage › pencil: the sensor open in the editor ("Edit sensor"), or null (Create).
    const [editSession, setEditSession] = useState<EditSession | null>(null);
    const editSessionRef = useRef<EditSession | null>(null);
    editSessionRef.current = editSession;
    const editSeq = useRef(0);

    // `adding` is separate from `loading` (which hides the explorer); the ref guards double clicks before re-render.
    const [adding, setAdding] = useState(false);
    const addingRef = useRef(false);
    // Why the last Add failed (from the backend), shown inline in the footer.
    const [addError, setAddError] = useState<string | null>(null);
    // Names the backend refused as 'already exists' that this window didn't know about; treated as taken.
    const [rejectedNames, setRejectedNames, rejectedRef] = useRefState<string[]>([]);

    const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showToast = useCallback((message: string, kind: ToastKind = 'ok') => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ message, kind });
        // A failure has to stay up long enough to read.
        toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 7000 : 2200);
    }, []);

    const [searchTerm, setSearchTerm] = useState("");
    const [activeTab, setActiveTab] = useState<'create' | 'manage'>('create');

    // This window's copy of the Dashboard's `specialSensorRecipes`; grows on create, shrinks on delete.
    const [recipes, setRecipes, recipesRef] = useRefState<SpecialSensorRecipe[]>([]);
    // Workspace of the last `sensors-data`; stamped on every task's emits (see `TaskCtx`).
    const workspaceIdRef = useRef<string | undefined>(undefined);
    // Rust dataset generation, sent as `expectedGeneration` so a stale window can't mutate another project's session.
    const generationRef = useRef<number | undefined>(undefined);
    // Bumped whenever work in flight stops belonging to this window's current
    // project (re-pointed, project closed, session found stale).
    const epochRef = useRef(0);
    // Has a `sensors-data` ever bound this window?
    const boundRef = useRef(false);
    // Set when the dataset is gone; mutations are refused until a `sensors-data` newer than `lostAtGenerationRef` re-binds.
    const [sessionLost, setSessionLost] = useState<string | null>(null);
    const sessionLostRef = useRef(false);
    const lostAtGenerationRef = useRef<number | undefined>(undefined);
    // Newest models re-read wins (also bumped on every invalidation).
    const refreshSeq = useRef(0);
    const [models, setModels, modelsRef] = useRefState<FailureModel[]>([]);
    // Workspace Running condition filters: a special sensor named there can't be deleted, and renames carry through.
    const [runningConditionFilters, setRunningConditionFilters, rcRef] = useRefState<WorkspaceSensorFilter[]>([]);
    // Whether `models`/`runningConditionFilters` are known fresh; deletion is blocked until then (a delete drops the column).
    const [failureKnown, setFailureKnown] = useState(false);
    // Formula tag -> sensors it references, from Rust; null until known, and Manage refuses deletes then. UI hint only.
    const [formulaRefs, setFormulaRefs] = useState<Map<string, string[]> | null>(null);
    // Formula text `formulaRefs` was read for; the data check waits until refs match current recipes to avoid flicker.
    const formulaRefsSourceRef = useRef<Map<string, string>>(new Map());
    // Special sensors whose recipe failed to rebuild: tag key -> reason (null = none given); null while unknown.
    // Their formula/sources stay editable even if a model uses them; the name stays locked.
    const [unrestored, setUnrestored, unrestoredRef] = useRefState<Map<string, string | null> | null>(null);
    // Bumped after every edit, so the check above runs again (a fix creates the
    // column; a failed one leaves it missing).
    const [sessionCheck, setSessionCheck] = useState(0);

    // Create, edit/rename and delete-commit run one at a time; every check happens inside the task against fresh state.
    const queue = useMemo(() => createSerialQueue(), []);
    const [busy, setBusy] = useState(false);
    useEffect(() => queue.subscribe(n => setBusy(n > 0)), [queue]);

    // Delete is two steps: hidden at click (Undo is free), then after UNDO_WINDOW_MS (or when settled/closing)
    // a commit re-checks dependents and drops the column.
    const deletionsRef = useRef<Deletion[]>([]);     // every hidden, unfinished deletion
    const slotRef = useRef<Deletion | null>(null);   // the one that can still be undone
    const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [hiddenTags, setHiddenTags] = useState<string[]>([]);
    const [pendingDelete, setPendingDelete] = useState<{ tags: string[]; label: string } | null>(null);

    // How the last save of an Edit session went.
    const [savingEdit, setSavingEdit] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    const syncHidden = () => setHiddenTags(deletionsRef.current.flatMap(d => d.tags));
    const isHidden = (tag: string) => deletionsRef.current.some(d => d.tags.some(t => sameTag(t, tag)));

    // Tasks capture the epoch; if it moves (project changed) they abort silently, with no retry or rollback.
    const captureCtx = (): TaskCtx => ({
        epoch: epochRef.current,
        workspaceId: workspaceIdRef.current,
        generation: generationRef.current,
    });
    const isCurrent = (ctx: TaskCtx) => ctx.epoch === epochRef.current;
    const assertCurrent = (ctx: TaskCtx) => { if (!isCurrent(ctx)) throw new TaskAbortedError(); };

    /** Stamps `expectedGeneration`, maps STALE_SESSION to a typed error, refuses to run or return once the epoch moved. */
    const invokerFor = (ctx: TaskCtx): Invoker => {
        const bound = bindToGeneration((cmd, args) => invoke<unknown>(cmd, args), ctx.generation);
        return async (cmd, args) => {
            assertCurrent(ctx);
            let out: unknown;
            try {
                out = await bound(cmd, args);
            } catch (err) {
                // A refusal that arrives after the window was re-pointed is
                // about the OLD project -- it must not mark the new one lost.
                assertCurrent(ctx);
                throw err;
            }
            assertCurrent(ctx);
            return out;
        };
    };

    /** Queue `work` bound to the project/dataset this window holds RIGHT NOW. */
    const runTask = <T,>(work: (ctx: TaskCtx) => Promise<T>): Promise<T> => {
        const ctx = captureCtx();
        return queue.run(async () => {
            assertCurrent(ctx);
            return work(ctx);
        });
    };

    /** Stop all in-flight work: bump epoch, drop pending deletions (incl. the undo-window one), invalidate re-reads; keeps the form. */
    const invalidateWork = () => {
        epochRef.current += 1;
        refreshSeq.current += 1;
        for (const d of deletionsRef.current) d.cancelled = true;
        deletionsRef.current = [];
        slotRef.current = null;
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        deleteTimer.current = null;
        setPendingDelete(null);
        syncHidden();
        addingRef.current = false;
        setAdding(false);
        setSavingEdit(false);
    };

    /** The dataset this window was bound to is gone. Further mutations are
     *  refused until a NEWER `sensors-data` re-binds the window. */
    const markSessionLost = (message: string = STALE_SESSION_MESSAGE) => {
        lostAtGenerationRef.current = generationRef.current;
        sessionLostRef.current = true;
        setSessionLost(message);
        invalidateWork();
    };

    /** Different project/dataset or recovery from lost: drop all old state (form, editor, queue, errors). */
    const resetForRebind = () => {
        invalidateWork();
        sessionLostRef.current = false;
        lostAtGenerationRef.current = undefined;
        setSessionLost(null);
        setQuickSel([]);
        setName('');
        setDescription('');
        setUnit('');
        setComponent('');
        setDraft(EMPTY_REPORT);
        setEditorKey(k => k + 1);
        setRejectedNames([]);
        setAddError(null);
        setSearchTerm('');
        setActiveTab('create');
        setEditSession(null);
        setEditError(null);
        setFormulaRefs(null);
        setUnrestored(null);
        setFailureKnown(false);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(null);
    };

    /** True when the failure is already handled: the dataset is gone, or the task was aborted or re-pointed. */
    const handleSessionLoss = (ctx: TaskCtx, err: unknown): boolean => {
        // Re-pointed / closed since this task was queued: stay silent, the
        // window may well be healthy for its NEW project.
        if (!isCurrent(ctx)) return true;
        if (err instanceof StaleSessionError) { markSessionLost(); return true; }
        return err instanceof TaskAbortedError;
    };

    /** Re-read models and Running condition from disk; with `ctx`, reads that task's workspace and aborts if the window moved. */
    const readFailureState = async (ctx: TaskCtx | null = null): Promise<{ models: FailureModel[]; rc: WorkspaceSensorFilter[] }> => {
        const id = ctx ? ctx.workspaceId : workspaceIdRef.current;
        // No workspace file to ask (the Dashboard had none): what it handed over
        // is all there is.
        if (!id) return { models: modelsRef.current, rc: rcRef.current };
        const ws = await loadWorkspaceData(id);
        if (ctx) assertCurrent(ctx);
        if (!ws) throw new Error('the workspace file could not be read');
        return { models: ws.failureGroupState?.models ?? [], rc: ws.failureGroupState?.runningConditionFilters ?? [] };
    };

    // Broadcast order isn't guaranteed: each broadcast triggers a re-read (writers persist before emit); only the newest applies
    // (`refreshSeq`, also bumped by invalidation).
    const refreshFailureState = () => {
        const seq = ++refreshSeq.current;
        void (async () => {
            try {
                const fresh = await readFailureState();
                if (seq !== refreshSeq.current) return;
                setModels(fresh.models);
                setRunningConditionFilters(fresh.rc);
                setFailureKnown(true);
            } catch (err) {
                console.warn('Failed to re-read models from the workspace file:', err);
                if (seq === refreshSeq.current) setFailureKnown(false);
            }
        })();
    };

    useEffect(() => {
        let unlistenData: (() => void) | undefined;

        const setup = async () => {
            const off = subscribe<{
                workspaceId?: string,
                sensors: string[],
                selectedSensors: string[],
                sensorMetadata: SensorMetadata[],
                specialSensorRecipes?: SpecialSensorRecipe[],
                models?: FailureModel[],
                runningConditionFilters?: WorkspaceSensorFilter[],
                generation?: number,
            }>('sensors-data', (event) => {
                debugLog("Received sensors-data:", event.payload);
                const incomingGeneration = typeof event.payload.generation === 'number' ? event.payload.generation : undefined;
                const boundGeneration = generationRef.current;
                if (boundRef.current) {
                    // Generation only grows: an older payload is from a dead Dashboard; never re-point backwards.
                    if (incomingGeneration !== undefined && boundGeneration !== undefined && incomingGeneration < boundGeneration) return;
                    // After loss, only a strictly newer generation may re-bind.
                    const lostAt = lostAtGenerationRef.current;
                    if (sessionLostRef.current && incomingGeneration !== undefined && lostAt !== undefined && incomingGeneration <= lostAt) return;
                    // Different project/dataset or recovery from lost: nothing of the old binding survives.
                    const differentProject = event.payload.workspaceId !== workspaceIdRef.current;
                    const differentDataset = incomingGeneration !== undefined && boundGeneration !== undefined && incomingGeneration !== boundGeneration;
                    if (differentProject || differentDataset || sessionLostRef.current) resetForRebind();
                }
                boundRef.current = true;
                // The window belongs to the last workspace/dataset it got data for; tasks capture these when queued.
                workspaceIdRef.current = event.payload.workspaceId;
                generationRef.current = incomingGeneration;
                setSensors(event.payload.sensors);
                // The picker deliberately starts empty; `selectedSensors` is not pre-checked.
                setSensorMetadata(event.payload.sensorMetadata);
                setPlottedSensors(event.payload.selectedSensors ?? []);
                setRecipes(event.payload.specialSensorRecipes ?? []);
                setModels(event.payload.models ?? []);
                setRunningConditionFilters(event.payload.runningConditionFilters ?? []);
                setFailureKnown(Array.isArray(event.payload.models));
                setLoading(false);
            });

            // Dashboard is going away: drop everything now, as backup for its own close.
            // Scoped to this window's workspace and dataset so a late copy can't kill a re-pointed window.
            const offClosing = subscribe<{ workspaceId?: string; generation?: number }>('workspace-closing', (event) => {
                if (!boundRef.current || sessionLostRef.current) return;
                if (event.payload?.workspaceId !== workspaceIdRef.current) return;
                const g = event.payload?.generation;
                if (typeof g === 'number' && generationRef.current !== undefined && g !== generationRef.current) return;
                markSessionLost();
            });

            unlistenData = () => { off(); offClosing(); };
            // Registered before asking, so the reply can't be missed.
            await off.ready;
            await offClosing.ready;

            await emit('request-sensors');

            try {
                const allHeaders = await invoke<string[]>('get_all_sensors');
                // Never reload the CSV here: `load_csv` would replace the shared Rust session and invalidate the bound generation.
                // An empty session means `sensors-data` has not arrived yet.
                if (allHeaders.length > 0) {
                    setSensors(prev => prev.length === 0 ? allHeaders.filter(h => h.trim().toLowerCase() !== 'timestamp') : prev);
                    setLoading(false);
                }
            } catch (err) {
                console.warn("Fallback loading failed:", err);
            }
        };

        setup();

        return () => {
            if (unlistenData) unlistenData();
            if (toastTimer.current) clearTimeout(toastTimer.current);
            if (deleteTimer.current) clearTimeout(deleteTimer.current);
            // Whatever is still queued or running belongs to a window that is
            // going away: it must not announce anything.
            epochRef.current += 1;
            refreshSeq.current += 1;
        };
        // The handlers only touch refs and stable setters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keep `models` and the Running condition fresh: delete protection reads them, and Build Model can change them meanwhile.
    // The payload is not applied (arrival order isn't guaranteed); it only triggers a re-read.
    useEffect(() => {
        const off = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            const id = workspaceIdRef.current;
            if (!id || event.payload?.workspaceId !== id) return;
            refreshFailureState();
        });
        return () => off();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // What the Dashboard really plotted after an add (merged with its selection, Pair Plot cap applied).
    useEffect(() => {
        const off = subscribe<{ workspaceId?: string; selectedSensors?: string[] }>('add-sensor-plot-result', (event) => {
            const id = workspaceIdRef.current;
            if (!id || event.payload?.workspaceId !== id) return;
            if (Array.isArray(event.payload.selectedSensors)) setPlottedSensors(event.payload.selectedSensors);
        });
        return () => off();
    }, []);

    // Formula references come from Rust's evaluator parser; a substring scan fails on nested names (`test` in `test extend`).
    useEffect(() => {
        const formulaRecipes = recipes.filter(r => r.kind === 'formula');
        if (formulaRecipes.length === 0) {
            formulaRefsSourceRef.current = new Map();
            setFormulaRefs(new Map());
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const refs = await invoke<string[][]>('extract_formula_refs', {
                    formulas: formulaRecipes.map(r => (r as { formula: string }).formula),
                });
                if (cancelled) return;
                formulaRefsSourceRef.current = new Map(formulaRecipes.map(r => [r.tag.trim().toLowerCase(), (r as { formula: string }).formula]));
                setFormulaRefs(new Map(formulaRecipes.map((r, i) => [r.tag.trim().toLowerCase(), refs[i] ?? []])));
            } catch (err) {
                console.error('Failed to read formula references:', err);
                // Stay null: Manage keeps deletion disabled rather than
                // deciding it is safe on missing information.
                if (!cancelled) setFormulaRefs(null);
            }
        })();
        return () => { cancelled = true; };
    }, [recipes]);

    // Special sensors with no session column (see `unrestored`): one `get_all_sensors`, more lookups only if one is missing.
    useEffect(() => {
        if (formulaRefs === null) return;
        if (recipes.length === 0) { setUnrestored(new Map()); return; }
        // Refs must match the current recipes; otherwise their lookup is still running and will re-trigger this effect.
        const source = formulaRefsSourceRef.current;
        const refsCurrent = recipes.every(r => r.kind !== 'formula' || source.get(tagKey(r.tag)) === r.formula);
        if (!refsCurrent) return;
        let cancelled = false;
        const epoch = epochRef.current;
        const generation = generationRef.current;
        // Unlock is decided only against the bound dataset; with no known generation, nothing is unlocked.
        if (generation === undefined) { setUnrestored(null); return; }
        const stillHere = () => !cancelled && epoch === epochRef.current;
        // Generation-pinned: `validate_formula` refuses with STALE_SESSION against another dataset.
        const inv = bindToGeneration((cmd, args) => invoke<unknown>(cmd, args), generation);
        (async () => {
            try {
                const read = await readUnrestored(inv, recipes, formulaRefs);
                if (!stillHere()) return;
                if (!read) { setUnrestored(null); return; }
                const { failed } = read.result;
                if (failed.length === 0) { setUnrestored(new Map()); return; }
                // Only unlock against the bound dataset; another session says nothing about ours.
                const current = await invoke<number | null>('get_session_generation');
                if (!stillHere()) return;
                if (current !== generation) { setUnrestored(null); return; }
                const reasons = new Map<string, string | null>();
                for (const tag of failed) {
                    const recipe = recipes.find(r => sameTag(r.tag, tag));
                    reasons.set(tagKey(tag), recipe ? await restoreReason(inv, recipe, read.columns, nameOf) : null);
                    if (!stillHere()) return;
                }
                setUnrestored(reasons);
            } catch (err) {
                console.warn('Could not check which special sensors have data:', err);
                if (stillHere()) setUnrestored(null);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recipes, formulaRefs, sessionCheck]);


    /** Take `d` out of the hidden set (finished, undone, or refused). */
    const dropDeletion = (d: Deletion) => {
        deletionsRef.current = deletionsRef.current.filter(x => x !== d);
        syncHidden();
    };

    /** `d` is being committed now: it can no longer be undone. */
    const claim = (d: Deletion) => {
        d.started = true;
        if (slotRef.current === d) {
            if (deleteTimer.current) clearTimeout(deleteTimer.current);
            deleteTimer.current = null;
            slotRef.current = null;
            setPendingDelete(null);
        }
    };

    /** Delete against fresh state: if a model, the Running condition or another sensor now uses it, cancel and say why. Click-time state may be UNDO_WINDOW_MS old; Rust ignores unknown filter sensors, so models would train on other rows. */
    const commitDeleteRaw = async (d: Deletion, ctx: TaskCtx) => {
        const tags = d.tags;
        const gone = (tag: string) => tags.some(t => sameTag(t, tag));
        const inv = invokerFor(ctx);

        let blocked: string | null = null;
        try {
            const fresh = await readFailureState(ctx);
            setModels(fresh.models);
            setRunningConditionFilters(fresh.rc);
            setFailureKnown(true);
            const formulaRecipes = recipesRef.current.filter(r => r.kind === 'formula');
            let refsMap = new Map<string, string[]>();
            if (formulaRecipes.length > 0) {
                const out = await inv('extract_formula_refs', {
                    formulas: formulaRecipes.map(r => (r as { formula: string }).formula),
                }) as string[][];
                refsMap = new Map(formulaRecipes.map((r, i) => [r.tag.trim().toLowerCase(), out[i] ?? []]));
            }
            const usage = buildSpecialSensorUsage({
                recipes: recipesRef.current,
                formulaRefs: refsMap,
                models: fresh.models,
                runningConditionFilters: fresh.rc,
                selectedSensors: [],
            });
            const used = tags.map(t => usageFor(usage, t)).filter((u): u is SpecialSensorUsage => !!u && !u.deletable);
            if (used.length > 0) blocked = `it is now used by ${describeUsage(used, nameOf)}`;
        } catch (err) {
            // Session lost while re-reading: this deletion belongs to another project; never touch the session.
            if (isSessionLostError(err)) throw err;
            console.error('Could not re-check what uses the sensor before deleting it:', err);
            blocked = `couldn't check whether anything still uses it (${errorText(err)})`;
        }
        if (blocked) {
            dropDeletion(d);
            showToast(`Didn't delete ${d.label}: ${blocked}. It is back in the list.`, 'error');
            return;
        }

        setRecipes(prev => prev.filter(r => !gone(r.tag)));
        setSensors(prev => prev.filter(t => !gone(t)));
        setSensorMetadata(prev => (prev ? prev.filter(m => !gone(m.tag)) : prev));
        setQuickSel(prev => prev.filter(t => !gone(t)));
        setPlottedSensors(prev => prev.filter(t => !gone(t)));
        setRejectedNames(prev => prev.filter(n => !gone(n)));
        // Drop the computed column from the session first, or a new sensor with the same name reads the old values.
        // On failure, still finish the removal but warn: the name stays taken until restart.
        try {
            await inv('remove_sensor_columns', { names: tags });
        } catch (err) {
            // Stale dataset or re-pointed window: nothing was removed or announced.
            if (isSessionLostError(err)) throw err;
            console.error('Failed to drop the deleted sensor column(s) from the session:', err);
            showToast(
                `Removed ${d.label} from the workspace, but couldn't free its data (${errorText(err)}). `
                + 'Creating a sensor with the same name may fail until the app is restarted.',
                'error',
            );
        }
        assertCurrent(ctx);
        try {
            await emit('delete-special-sensors', { tags, workspaceId: ctx.workspaceId, generation: ctx.generation });
        } catch (err) {
            console.error('Failed to tell the dashboard about the deletion:', err);
        }
        dropDeletion(d);
    };

    /** Commit every deletion that is still waiting (and matches `pred`) NOW,
     *  inside the current task. */
    const settleDeletions = async (ctx: TaskCtx, pred: (d: Deletion) => boolean = () => true) => {
        for (const d of [...deletionsRef.current]) {
            if (d.started || d.cancelled || !pred(d)) continue;
            claim(d);
            await commitDeleteRaw(d, ctx);
        }
    };

    /** Queue `d`'s commit; resolves when applied. */
    const scheduleCommit = (d: Deletion): Promise<void> => {
        if (d.queued || d.started || d.cancelled) return Promise.resolve();
        d.queued = true;
        return runTask(async ctx => {
            // Undone while it was waiting, or already settled by another task.
            if (d.cancelled || d.started) return;
            claim(d);
            await commitDeleteRaw(d, ctx);
        }).catch(err => {
            // The window was re-pointed / closed / found stale meanwhile.
            if (isSessionLostError(err)) {
                if (err instanceof StaleSessionError) markSessionLost();
                return;
            }
            console.error('Delete failed:', err);
        });
    };

    const handleDeleteSensor = (tag: string) => {
        if (sessionLostRef.current) { showToast(STALE_SESSION_MESSAGE, 'error'); return; }
        // One undoable deletion at a time: a new delete makes the previous one
        // final (its commit is queued) and takes the slot.
        const previous = slotRef.current;
        if (previous) {
            if (deleteTimer.current) clearTimeout(deleteTimer.current);
            deleteTimer.current = null;
            void scheduleCommit(previous);
        }
        const d: Deletion = { tags: [tag], label: nameOf(tag), cancelled: false, started: false, queued: false };
        deletionsRef.current = [...deletionsRef.current, d];
        slotRef.current = d;
        setPendingDelete({ tags: d.tags, label: d.label });
        // A hidden sensor must not stay picked for the form being filled in.
        setQuickSel(prev => prev.filter(t => !sameTag(t, tag)));
        syncHidden();
        deleteTimer.current = setTimeout(() => {
            deleteTimer.current = null;
            void scheduleCommit(d);
        }, UNDO_WINDOW_MS);
    };

    const handleUndoDelete = () => {
        const d = slotRef.current;
        // Once its commit has begun it is final (while it only WAITS in the
        // queue, behind a slow edit, Undo still works).
        if (!d || d.started) return;
        d.cancelled = true;
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        deleteTimer.current = null;
        slotRef.current = null;
        setPendingDelete(null);
        dropDeletion(d);
    };

    /** Manage rows: a sensor in its undo window is already gone, which unlocks sensors built on it. */
    const manageRecipes = useMemo(() => {
        if (hiddenTags.length === 0) return recipes;
        return recipes.filter(r => !hiddenTags.some(t => sameTag(t, r.tag)));
    }, [recipes, hiddenTags]);

    /** Sensors minus pending deletions; feeds every source picker so a pending-delete sensor can't become a source. Its name is reusable at once: the delete settles before creation. */
    const liveSensors = useMemo(() => {
        if (hiddenTags.length === 0) return sensors;
        return sensors.filter(s => !hiddenTags.some(t => sameTag(t, s)));
    }, [sensors, hiddenTags]);


    /** Save an edited sensor (rename if `renamedFrom`); recompute in build order with rollback (`runSpecialSensorEdit`). A rename rewrites other recipes, tells the Dashboard and removes the old column LAST (skipped if only the case changed). Edit lock: a model or the Running condition using it blocks rename/value changes; models are re-read from disk first. */
    const saveEditTask = async (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string }, ctx: TaskCtx, sessionId: number | null) => {
        const oldTag = next.renamedFrom;
        const newTag = next.recipe.tag;
        const removesOldColumn = !!oldTag && !sameTag(oldTag, newTag);
        const inv = invokerFor(ctx);
        try {
            // Any deletion still waiting is settled first, so the dependency
            // graph this reasons about matches what the dashboard holds.
            await settleDeletions(ctx);

            // Fresh models + Running condition for the edit lock; unreadable counts as locked.
            let failureState: EditFailureState;
            // Full rows: the repair demotion needs condition values, not just sensor names.
            let freshRc: WorkspaceSensorFilter[] = [];
            try {
                const fresh = await readFailureState(ctx);
                freshRc = fresh.rc;
                setModels(fresh.models);
                setRunningConditionFilters(fresh.rc);
                setFailureKnown(true);
                failureState = { known: true, models: fresh.models, runningConditionFilters: fresh.rc };
            } catch (err) {
                if (isSessionLostError(err)) throw err;
                console.error('Could not re-read the models before editing a sensor:', err);
                setFailureKnown(false);
                failureState = { known: false, models: [], runningConditionFilters: [], reason: errorText(err) };
            }

            if (oldTag) {
                if (!newTag.trim()) throw new Error('Name is required.');
                const problem = nameProblem(newTag, []);
                if (problem) throw new Error(problem);
                const collides = sensorsRef.current.some(s => sameTag(s, newTag) && !sameTag(s, oldTag));
                if (collides) throw new Error(`"${newTag}" is already in use by another sensor.`);
            }

            // Same name and maths: metadata-only save, no recompute (a recipe Rust refuses could otherwise not save a description).
            const stored = recipesRef.current.find(r => sameTag(r.tag, newTag));
            const unchanged = !oldTag && !!stored && recipesEquivalent(stored, next.recipe);

            // A sensor whose replay failed (no column) may have formula/sources fixed even if a model uses it, never renamed.
            // Re-checked against the session, pinned to the bound generation.
            let repairing = false;
            let missingBefore: string[] = [];
            // Also asked when the list can't say (null): the editor keeps a repair session unlocked through such a gap.
            const listed = unrestoredRef.current;
            if (!oldTag && !unchanged && stored && (listed === null || listed.has(tagKey(newTag)))
                && ctx.generation !== undefined) {
                const current = await inv('get_session_generation', {});
                assertCurrent(ctx);
                if (current === ctx.generation) {
                    const read = await readUnrestored(inv, recipesRef.current, null);
                    assertCurrent(ctx);
                    repairing = !!read && read.result.failed.some(t => sameTag(t, newTag));
                    if (repairing && read) missingBefore = [...read.result.failed, ...read.result.skipped];
                }
            }

            const outcome: EditOutcome = unchanged && stored
                ? {
                    nextInputs: [],
                    downstream: [],
                    renamedDownstream: [],
                    recipe: stored,
                    metadataOnly: true,
                    applyEdit: list => list.map(r => (sameTag(r.tag, newTag) ? stored : r)),
                }
                : await runSpecialSensorEdit({
                    recipes: recipesRef.current,
                    next: next.recipe,
                    oldTag,
                    invoker: inv,
                    // No lock check for a repair; the recompute stays generation-pinned and on failure removes the columns it created.
                    failureState: repairing ? undefined : failureState,
                    repair: repairing ? { missingBefore } : undefined,
                    labelOf: tag => sensorPlainLabel(buildSensorLookup(buildSensorLookup(null, sensorMetadataRef.current), [next.metadata])(tag)),
                });
            assertCurrent(ctx);
            const { downstream, renamedDownstream, recipeOrder, applyEdit } = outcome;
            const stillBroken = outcome.stillBroken ?? [];
            // A repair gives the sensor and its dependents new values: the Dashboard sets models trained on them to Incomplete and out of date.
            // The count shown uses the same rule.
            const affectedTags = repairing && !outcome.metadataOnly ? [next.recipe.tag, ...downstream.map(r => r.tag)] : [];
            // null = models unreadable; the toast omits the number (the Dashboard still demotes from disk).
            const retrainCount = affectedTags.length === 0 ? 0
                : failureState.known
                    ? demoteModelsTrainedOnSensors(failureState.models, { runningConditionFilters: freshRc }, affectedTags).retrain.length
                    : null;
            // What was really saved: for a metadata-only save of a locked
            // sensor, the stored recipe untouched.
            const savedRecipe = outcome.recipe;

            setRecipes(prev => reorderRecipesByTags(applyEdit(prev), recipeOrder));
            setSensorMetadata(prev => {
                const existing = prev ?? [];
                const withoutOld = oldTag ? existing.filter(m => !sameTag(m.tag, oldTag)) : existing;
                return withoutOld.some(m => sameTag(m.tag, next.metadata.tag))
                    ? withoutOld.map(m => (sameTag(m.tag, next.metadata.tag) ? next.metadata : m))
                    : [...withoutOld, next.metadata];
            });

            if (oldTag) {
                setSensors(prev => renameTagInArray(prev, oldTag, newTag));
                setQuickSel(prev => renameTagInArray(prev, oldTag, newTag));
                setPlottedSensors(prev => renameTagInArray(prev, oldTag, newTag));
                // Update this window's copies at once; otherwise the renamed sensor looks unused and could be deleted.
                setModels(prev => renameTagInModels(prev, oldTag, newTag));
                setRunningConditionFilters(prev => renameTagInRunningConditionFilters(prev, oldTag, newTag));
            }

            assertCurrent(ctx);
            if (oldTag) {
                await emit('rename-special-sensor', {
                    oldTag,
                    newTag,
                    recipe: next.recipe,
                    metadata: next.metadata,
                    updatedRecipes: renamedDownstream,
                    recipeOrder,
                    workspaceId: ctx.workspaceId,
                    generation: ctx.generation,
                });
            } else {
                const payload: UpdateSpecialSensorPayload = {
                    recipe: savedRecipe,
                    metadata: next.metadata,
                    recomputed: outcome.metadataOnly
                        ? []
                        : [next.recipe.tag, ...downstream.map(r => r.tag)].filter(t => !stillBroken.some(b => sameTag(b.tag, t))),
                    recipeOrder,
                    workspaceId: ctx.workspaceId,
                    generation: ctx.generation,
                    ...(affectedTags.length > 0 ? { repaired: true, affectedTags } : {}),
                };
                await emit('update-special-sensor', payload);
            }

            // The saved description, under the old or the new tag.
            const savedName = (tag: string) => sensorPlainLabel(buildSensorLookup(null, [{ ...next.metadata, tag }])(tag));

            // Last, after the Dashboard knows the new name; failure only leaves an orphan column, so warn rather than throw.
            let cleanupWarning: string | null = null;
            if (removesOldColumn && oldTag) {
                try {
                    await inv('remove_sensor_columns', { names: [oldTag] });
                } catch (err) {
                    if (isSessionLostError(err)) throw err;
                    console.error('Failed to drop the old column after a rename:', err);
                    cleanupWarning = `Renamed "${savedName(oldTag)}" to "${savedName(newTag)}", but couldn't free the old data (${errorText(err)}). `
                        + `Creating a sensor named "${oldTag}" may fail until the app is restarted.`;
                }
            }

            // The Edit session that saved closes (a newer one the user opened meanwhile stays).
            if (sessionId !== null && editSessionRef.current?.id === sessionId) closeEdit();
            if (cleanupWarning) {
                showToast(cleanupWarning, 'error');
            } else {
                showToast(
                    oldTag
                        ? `Renamed "${savedName(oldTag)}" to "${savedName(newTag)}"${downstream.length > 0 ? ` — updated ${downstream.length} sensor(s) built on it` : ''}`
                        : repairing
                            ? describeRepair(savedName(next.recipe.tag), downstream.length - stillBroken.length, stillBroken, retrainCount, nameOf)
                        : downstream.length > 0
                            ? `Updated ${savedName(next.recipe.tag)} — recomputed ${downstream.length} sensor(s) built on it`
                            : `Updated ${savedName(next.recipe.tag)}`,
                );
            }
        } catch (err) {
            // The dataset is not ours any more (stale generation, project
            // closed, window re-pointed): no rollback, no cleanup, no emit.
            const wasCurrent = isCurrent(ctx);
            if (handleSessionLoss(ctx, err)) {
                if (wasCurrent) setEditError(STALE_SESSION_MESSAGE);
                return;
            }
            let message = errorText(err);
            if (err instanceof SpecialSensorEditError) {
                if (err.inconsistent.length > 0) {
                    message += ` The previous values of ${err.inconsistent.map(nameOf).join(', ')} could not be restored, `
                        + 'so they may show wrong numbers. Reopen the workspace to rebuild them.';
                }
                if (err.leftover.length > 0) {
                    // These had NO values before the edit -- there is nothing
                    // "previous" to restore, only values of the refused change.
                    message += ` ${err.leftover.map(nameOf).join(', ')} had no values before this change, and the values it produced `
                        + 'could not be removed again, so they may show numbers from the refused change. Reopen the workspace to clear them.';
                }
                if (err.touched && isCurrent(ctx)) {
                    // Some columns were overwritten (then rolled back): charts
                    // may have fetched the in-between values meanwhile.
                    try { await emit('special-sensor-data-changed', { workspaceId: ctx.workspaceId, generation: ctx.generation }); } catch { /* best effort */ }
                }
            }
            setEditError(message);
        }
    };

    const handleSaveEdit = (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string }) => {
        if (sessionLostRef.current) { setEditError(STALE_SESSION_MESSAGE); return; }
        const epoch = epochRef.current;
        const sessionId = editSessionRef.current?.id ?? null;
        setSavingEdit(true);
        setEditError(null);
        void runTask(ctx => saveEditTask(next, ctx, sessionId))
            .catch(err => {
                if (isSessionLostError(err)) return;
                console.error('Edit failed:', err);
                if (epoch === epochRef.current) setEditError(errorText(err));
            })
            .finally(() => {
                if (epoch !== epochRef.current) return;
                setSavingEdit(false);
                // Which sensors have data may have changed (a fixed recipe now
                // has its column) -- look again.
                setSessionCheck(n => n + 1);
            });
    };

    const handleClose = async () => {
        // Closing makes a mid-undo deletion real; it queues behind work in flight.
        const d = slotRef.current;
        if (d) await scheduleCommit(d);
        await queue.idle();
        await getCurrentWindow().close();
    };

    // Create builds what the Formula editor holds; an empty editor builds nothing.
    const isCreatingSomething = !editSession && draft.state !== null;
    const currentName = name;

    // Names a new sensor can't take: columns, recipes, backend-rejected names (trimmed, case-insensitive like Rust).
    const takenTags = useMemo(
        () => [...liveSensors, ...manageRecipes.map(r => r.tag), ...rejectedNames],
        [liveSensors, manageRecipes, rejectedNames],
    );
    const nameError = isCreatingSomething ? nameProblem(currentName, takenTags) : null;

    // Name, Description, Unit and Component are all required to add.
    const missingCreateFields = isCreatingSomething
        ? [
            !currentName.trim() && 'a name',
            !description.trim() && 'a description',
            !unit.trim() && 'a unit',
            !component.trim() && 'a component',
        ].filter((f): f is string => !!f)
        : [];
    // While the formula has an issue, Add is disabled and the footer repeats the message.
    const formulaBlocked = !!draft.issue;
    const canAdd = isCreatingSomething && missingCreateFields.length === 0 && !nameError && !formulaBlocked;
    // Footer line, most actionable first: formula issue, bad name, blank fields, last failure.
    const footerIssue = !isCreatingSomething
        ? addError
        : formulaBlocked
            ? draft.issue!.message
            : nameError
                ? 'Fix the name before adding.'
                : (missingCreateFields.length > 0 ? `Fill in ${missingCreateFields.join(', ')} before adding.` : addError);

    // A failed Add's message is cleared when the inputs change; keyed on serialized inputs so an identical re-report keeps it.
    const attemptKey = JSON.stringify([draft.state, name]);
    useEffect(() => {
        setAddError(null);
    }, [attemptKey]);


    /** Runs the Create form's calculation; returns the tags to plot, their metadata and recipes (recomputed after a reopen). */
    const computeRound = async (snap: CreateSnapshot, inv: Invoker): Promise<{ plotSensors: string[]; newMetadata: SensorMetadata[]; newRecipes: SpecialSensorRecipe[] }> => {
        const customName = snap.name.trim();
        const metadataFor = (tag: string): SensorMetadata => ({
            tag,
            description: snap.description.trim() || customName,
            unit: snap.unit.trim(),
            component: snap.component.trim() || 'Uncategorized',
        });
        if (snap.state.mode === 'formula') {
            // The stored text: the field's own text with "Round the result" applied.
            const formula = editorStateFormula(snap.state);
            const newSensorName = await inv('evaluate_formula', { formula, customName: customName || null }) as string;
            return {
                plotSensors: [newSensorName],
                newMetadata: [metadataFor(newSensorName)],
                newRecipes: [{ kind: 'formula', tag: newSensorName, formula }],
            };
        }
        // An Average / Median block: the aggregate path, rounding in `multiOp.decimals`.
        const config = blockOperationConfig(snap.state.type, snap.state.decimals, customName);
        const sources = [...snap.state.sources];
        const newSensorName = await inv('calculate_new_sensor', { sensors: sources, config }) as string;
        return {
            plotSensors: [newSensorName],
            newMetadata: [metadataFor(newSensorName)],
            newRecipes: [{ kind: 'operation', tag: newSensorName, sourceSensors: sources, operationConfig: config }],
        };
    };

    const createSensor = async (snap: CreateSnapshot, ctx: TaskCtx) => {
        const attemptedName = snap.name.trim();
        const inv = invokerFor(ctx);

        // Settle a pending delete holding this name first, or the backend refuses it as 'already exists'.
        if (attemptedName) await settleDeletions(ctx, d => d.tags.some(t => sameTag(t, attemptedName)));

        // Re-check the name against fresh state: an edit/rename may have taken it while queued.
        {
            const taken = [
                ...sensorsRef.current.filter(s => !isHidden(s)),
                ...recipesRef.current.filter(r => !isHidden(r.tag)).map(r => r.tag),
                ...rejectedRef.current,
            ];
            const problem = nameProblem(snap.name, taken);
            if (problem) throw new Error(problem);
        }

        // A pending-delete source (typed by hand) would lose its column from under the new sensor.
        if (deletionsRef.current.length > 0) {
            let used: string[] = snap.state.mode === 'block' ? snap.state.sources : [];
            if (snap.state.mode === 'formula') {
                const out = await inv('extract_formula_refs', { formulas: [editorStateFormula(snap.state)] }) as string[][];
                used = out?.[0] ?? [];
            }
            const hiddenSource = used.find(isHidden);
            if (hiddenSource !== undefined) {
                throw new Error(`"${nameOf(hiddenSource)}" is being deleted. Undo that first, or pick another sensor.`);
            }
        }

        const { plotSensors, newMetadata, newRecipes } = await computeRound(snap, inv);
        assertCurrent(ctx);

        const createdName = newMetadata[0]?.tag;
        if (createdName) {
            // Make the new sensor pickable as an input for the next round
            // (e.g. building a second sensor on top of the first).
            setSensors(prev => (prev.some(t => sameTag(t, createdName)) ? prev : [...prev, createdName]));
            setSensorMetadata(prev => {
                const existing = prev ?? [];
                return existing.some(m => sameTag(m.tag, createdName)) ? existing : [...existing, newMetadata[0]];
            });
            // Show up on the Manage tab right away, without waiting for
            // the dashboard to send a fresh sensors-data.
            setRecipes(prev => {
                const others = prev.filter(r => !newRecipes.some(n => sameTag(n.tag, r.tag)));
                return [...others, ...newRecipes];
            });
        }

        // `sensors` is a delta the Dashboard ADDS; it answers with `add-sensor-plot-result`.
        try {
            await emit('add-sensor-selection', {
                sensors: plotSensors,
                operation: null,
                newMetadata,
                newRecipes,
                workspaceId: ctx.workspaceId,
                generation: ctx.generation,
            });
        } catch (err) {
            console.error('Failed to tell the dashboard about the new sensor:', err);
            showToast(`Created ${createdName ? sensorPlainLabel(buildSensorLookup(null, newMetadata)(createdName)) : 'the sensor'}, but couldn't tell the dashboard (${errorText(err)}). Reopen the workspace to see it.`, 'error');
        }

        showToast(createdName ? `Added: ${newMetadata[0].description || createdName}` : `Added ${plotSensors.length} sensor(s)`);

        // Reset the form and remount the editor (`editorKey`); skip if an Edit session holds the form.
        if (editSessionRef.current) return;
        setQuickSel([]);
        setName('');
        setDescription('');
        setUnit('');
        setComponent('');
        setDraft(EMPTY_REPORT);
        setEditorKey(k => k + 1);
    };

    // Queues the configured sensor, tells the Dashboard once built, clears the form; the window stays open.
    const handleAdd = () => {
        // Guards a second click that lands before React disables the button, which would create twice.
        if (sessionLostRef.current) { setAddError(STALE_SESSION_MESSAGE); return; }
        if (addingRef.current || !canAdd || !draft.state) return;
        addingRef.current = true;
        setAdding(true);
        setAddError(null);
        const snap: CreateSnapshot = { state: draft.state, description, unit, component, name: currentName };
        const attemptedName = currentName.trim();
        const epoch = epochRef.current;
        void runTask(ctx => createSensor(snap, ctx))
            .catch((err: unknown) => {
                // Dataset gone / window re-pointed: say so (once, in the banner)
                // and leave every list as it is.
                if (isSessionLostError(err)) {
                    if (err instanceof StaleSessionError && epoch === epochRef.current) markSessionLost();
                    return;
                }
                console.error("Failed to add sensor:", err);
                if (epoch !== epochRef.current) return;
                const message = errorText(err);
                // The backend knows a name this window didn't: remember it so the Name field flags it.
                if (attemptedName && /already exists/i.test(message)) {
                    setRejectedNames(prev => (prev.some(n => sameTag(n, attemptedName)) ? prev : [...prev, attemptedName]));
                }
                setAddError(message);
            })
            .finally(() => {
                // A task of an older epoch must not unlock (or lock) the form
                // of the project the window serves NOW.
                if (epoch !== epochRef.current) return;
                addingRef.current = false;
                setAdding(false);
            });
    };

    const toggleQuick = useCallback((sensor: string) => {
        setQuickSel(prev => (prev.some(t => sameTag(t, sensor)) ? prev.filter(t => !sameTag(t, sensor)) : [...prev, sensor]));
    }, []);
    const clearQuick = useCallback(() => setQuickSel([]), []);
    const insertIntoFormula = useCallback((sensor: string) => editorRef.current?.insertSensor(sensor), []);
    const handleReport = useCallback((r: FormulaEditorReport) => setDraft(r), []);

    /** Close the Edit session: back to an empty Create form, on the Manage tab it came from. */
    const closeEdit = () => {
        setEditSession(null);
        setName('');
        setDescription('');
        setUnit('');
        setComponent('');
        setDraft(EMPTY_REPORT);
        setQuickSel([]);
        setEditError(null);
        setEditorKey(k => k + 1);
        setActiveTab('manage');
    };
    const startEdit = (tag: string) => {
        const recipe = recipesRef.current.find(r => sameTag(r.tag, tag));
        if (!recipe) return;
        const meta = sensorMetadata?.find(m => sameTag(m.tag, tag));
        const listed = unrestored?.get(tagKey(tag));
        setEditSession({
            id: ++editSeq.current,
            recipe,
            repair: unrestored?.has(tagKey(tag)) ? { reason: listed ?? null } : null,
        });
        setQuickSel([]);
        setEditError(null);
        setName(recipe.tag);
        setDescription(meta?.description ?? '');
        setUnit(meta?.unit ?? '');
        setComponent(meta?.component ?? '');
        setDraft(EMPTY_REPORT);
        setEditorKey(k => k + 1);
        setActiveTab('create');
    };

    // A late data check that finds a sensor with no data unlocks it from then on (latched; the save decides again).
    useEffect(() => {
        if (!editSession || editSession.repair || !unrestored) return;
        const key = tagKey(editSession.recipe.tag);
        if (!unrestored.has(key)) return;
        setEditSession(s => (s && s.id === editSession.id ? { ...s, repair: { reason: unrestored.get(key) ?? null } } : s));
    }, [editSession, unrestored]);

    // What uses the sensor being edited -- the same rule Manage shows (only computed while editing).
    const editUsageAll = useMemo(() => (editSession ? buildSpecialSensorUsage({
        recipes: manageRecipes,
        formulaRefs: formulaRefs ?? new Map(),
        models,
        runningConditionFilters,
        selectedSensors: plottedSensors,
        failureKnown: failureKnown && formulaRefs !== null,
    }) : null), [editSession, manageRecipes, formulaRefs, models, runningConditionFilters, plottedSensors, failureKnown]);
    const editUsage = editSession && editUsageAll ? usageFor(editUsageAll, editSession.recipe.tag) : undefined;
    const editDependents = useMemo(
        () => (editSession && editUsageAll ? transitiveDependents(editUsageAll, editSession.recipe.tag) : []),
        [editSession, editUsageAll],
    );
    const repairing = !!editSession?.repair;
    const lockNow = !!editUsage?.editLock.locked;
    // A lock on a sensor with data freezes the maths unless already edited; then Save is refused with the reason.
    const editLocked = !!editSession && lockNow && !repairing && !draft.edited;
    const lockedAfterEdit = !!editSession && lockNow && !repairing && draft.edited;
    const editNameLocked = !!editSession && (lockNow || repairing);
    const editorLock = useMemo<FormulaEditorLock | null>(
        () => (editLocked && editUsage ? { short: shortLock(editUsage, nameOf), detail: describeEditLock(editUsage.editLock, nameOf) } : null),
        // nameOf reads the metadata through a ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [editLocked, editUsage, sensorMetadata],
    );
    // Repair: how many models go back to Incomplete (the real rule, on the models this window knows).
    const repairRetrain = useMemo(() => {
        if (!editSession?.repair) return null;
        if (!failureKnown) return null;
        const tags = [editSession.recipe.tag, ...editDependents];
        return demoteModelsTrainedOnSensors(models, { runningConditionFilters }, tags).retrain.length;
    }, [editSession, editDependents, failureKnown, models, runningConditionFilters]);
    const editorRepair = useMemo(
        () => (editSession?.repair ? { reason: editSession.repair.reason, retrain: repairRetrain } : null),
        [editSession, repairRetrain],
    );

    const editName = name.trim();
    const editRenamed = !!editSession && !editNameLocked && editName !== editSession.recipe.tag;
    const editNameError = !editSession || editNameLocked ? null
        : !editName ? 'Name is required'
            : editRenamed && liveSensors.some(s => !sameTag(s, editSession.recipe.tag) && sameTag(s, editName))
                ? `"${editName}" is already in use by another sensor`
                : editRenamed ? nameProblem(editName, []) : null;
    const editMissing = editSession ? [
        !editNameLocked && !editName && 'a name',
        !description.trim() && 'a description',
        !unit.trim() && 'a unit',
        !component.trim() && 'a component',
    ].filter((f): f is string => !!f) : [];
    // What blocks Save, most actionable first (the footer repeats it).
    const editBlock = !editSession ? null
        : lockedAfterEdit
            ? `This sensor is now locked: ${editUsage ? describeEditLock(editUsage.editLock, nameOf) : ''} Your change to its calculation can't be saved — Cancel edit to discard it.`
            // An untouched stored calculation never blocks a save, even if Rust would refuse the recipe.
            : !editLocked && draft.edited && !draft.state ? 'The formula is empty.'
                : !editLocked && draft.edited && draft.issue ? draft.issue.message
                    : editNameError ? 'Fix the name before saving.'
                        : editMissing.length > 0 ? `Fill in ${editMissing.join(', ')} before saving.`
                            : null;
    // Why the last save was refused wins the footer until the user changes something.
    const editIssue = editError ?? editBlock;
    const editHint = editLocked ? 'Saves the description, unit and component.'
        : repairing
            ? (repairRetrain === null
                ? 'Saving restores the data; models trained on it go back to Incomplete (set points kept).'
                : repairRetrain > 0
                    ? `Saving restores the data; ${repairRetrain} model${repairRetrain === 1 ? '' : 's'} go${repairRetrain === 1 ? 'es' : ''} back to Incomplete (set points kept).`
                    : 'Saving restores the data.')
            : 'Saves the changes; the chart updates.';
    // (A lost session is not a reason to grey Save out: the click answers with the banner's message.)
    const canSaveEdit = !!editSession && !savingEdit && !editBlock;
    // A refused save's message belongs to THAT attempt: a change to the maths or the name clears it.
    const editAttemptKey = editSession ? JSON.stringify([editSession.id, draft.state, name]) : '';
    useEffect(() => {
        setEditError(null);
    }, [editAttemptKey]);

    const handleSaveFromEditor = () => {
        const session = editSession;
        if (!session || !canSaveEdit) return;
        const savedTag = editNameLocked ? session.recipe.tag : editName;
        let recipe: SpecialSensorRecipe;
        if (editLocked || !draft.state || !draft.edited) {
            // The calculation was not touched: send what is stored (under the new
            // name on a rename), never a re-derivation of it.
            recipe = savedTag === session.recipe.tag ? session.recipe : retagRecipe(session.recipe, savedTag);
        } else {
            recipe = editorStateToRecipe(draft.state, savedTag);
        }
        const meta = sensorMetadata?.find(m => sameTag(m.tag, session.recipe.tag));
        handleSaveEdit({
            recipe,
            metadata: {
                ...(meta ?? { tag: savedTag, description: '', unit: '', component: '' }),
                tag: savedTag,
                description: description.trim(),
                unit: unit.trim(),
                component: component.trim() || 'Uncategorized',
            },
            renamedFrom: editRenamed ? session.recipe.tag : undefined,
        });
    };

    // Editor options exclude the edited sensor and its dependents: no self-dependency.
    const editorSensors = useMemo(() => {
        if (!editSession) return liveSensors;
        const skip = new Set([editSession.recipe.tag, ...editDependents].map(tagKey));
        return liveSensors.filter(t => !skip.has(tagKey(t)));
    }, [liveSensors, editSession, editDependents]);
    // Names not flagged unknown: columns plus all special sensors (a missing column gets its reason from Rust).
    const knownSensors = useMemo(() => [...sensors, ...recipes.map(r => r.tag)], [sensors, recipes]);
    const componentOptions = useMemo(
        () => Array.from(new Set((sensorMetadata ?? []).map(m => m.component).filter((c): c is string => !!c))).sort(),
        [sensorMetadata],
    );

    const filteredSensors = useMemo(() => {
        if (!searchTerm) return editorSensors;
        const lowerTerm = searchTerm.toLowerCase();
        return editorSensors.filter(s => {
            const meta = sensorMetadata?.find(m => m.tag === s);
            const searchStr = meta
                ? `${s} ${meta.description} ${meta.component} ${meta.unit}`.toLowerCase()
                : s.toLowerCase();
            return searchStr.includes(lowerTerm);
        });
    }, [editorSensors, searchTerm, sensorMetadata]);


    return (
        // Labels resolve via the window's metadata and the special sensors' badges.
        <SensorMetaProvider metadata={sensorMetadata} special={recipes}>
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', position: 'relative' }}>
            {/* Header — 12px 16px padding + bottom border, the app's dialog header shape */}
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center" style={{ gap: '14px' }}>
                    <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Special Sensors</h2>
                    {/* Create and Manage are tabs of one window: build a sensor, then review or remove it. */}
                    <div className="special-sensor-tabs" role="tablist">
                        {(['create', 'manage'] as const).map(tab => (
                            <button
                                key={tab}
                                role="tab"
                                aria-selected={activeTab === tab}
                                onClick={() => setActiveTab(tab)}
                                className={activeTab === tab ? 'is-on' : ''}
                            >
                                {tab === 'create' ? 'Create' : `Manage ${recipes.length > 0 ? ` (${recipes.length})` : ''}`}
                            </button>
                        ))}
                    </div>
                    {/* Changes are applied one at a time (see `queue`); this says
                        one is in progress. */}
                    {busy && (
                        <span data-testid="special-sensor-busy" aria-live="polite" className="pointer-events-none" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                            Applying changes…
                        </span>
                    )}
                </div>
                <button
                    onClick={handleClose}
                    className="scatter-regl-btn scatter-regl-btn-icon"
                    title="Close"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Dataset gone (project closed or reloaded): nothing can change until the Dashboard re-sends its data. */}
            {sessionLost && (
                <div
                    role="alert"
                    data-testid="special-sensor-session-lost"
                    className="shrink-0 text-xs"
                    style={{ padding: '8px 16px', color: 'var(--danger)', borderBottom: '1px solid var(--danger)', backgroundColor: 'var(--card-bg)' }}
                >
                    {sessionLost}
                </div>
            )}

            {/* Explorer column + Tooling column; kept mounted (hidden via `display`) while Manage shows. */}
            <div
                className="special-sensor-body"
                aria-busy={adding || undefined}
                style={{
                    display: activeTab === 'create' ? 'grid' : 'none',
                    // Never moved: the stylesheet's width (320 px, 230 px under 860 px).
                    ...(paneWidth ? { gridTemplateColumns: `${paneWidth}px minmax(0, 1fr)` } : null),
                    ...(adding ? { pointerEvents: 'none', opacity: 0.7 } : null),
                }}
            >
                <PaneResizeHandle
                    width={paneWidth || paneDefaultWidth}
                    defaultWidth={paneDefaultWidth}
                    onChange={setPaneWidth}
                    storageKey={PANE_WIDTH_KEY}
                    label="Resize the sensor list"
                    controls="add-sensor-list-pane"
                    testid="ss-list-resize"
                />
                {/* Left: the sensor list -- a click PICKS a sensor for Quick build, `$` inserts it at the caret. */}
                <div id="add-sensor-list-pane" className={`special-sensor-left${editLocked ? ' is-off' : ''}`}>
                    {loading ? (
                        <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
                    ) : (
                        <SensorExplorer
                            sensors={filteredSensors}
                            sensorMetadata={sensorMetadata}
                            selectedSensors={quickSel}
                            onToggleSensor={toggleQuick}
                            onInsertSensor={insertIntoFormula}
                            searchTerm={searchTerm}
                            onSearchChange={setSearchTerm}
                        />
                    )}
                    <div className="special-sensor-left-hint">
                        {editLocked
                            ? 'The formula is locked, so sensors cannot be added.'
                            : 'Click a sensor to pick it for Quick build · $ inserts it at the cursor.'}
                    </div>
                </div>

                {/* Right: the Formula editor (Quick build, the formula, preview) and the sensor's fields */}
                <div className="special-sensor-right custom-scrollbar">
                    <div className="fx">
                        <SpecialSensorFormulaEditor
                            key={editorKey}
                            ref={editorRef}
                            sensors={editorSensors}
                            knownSensors={knownSensors}
                            generation={generationRef.current}
                            initialRecipe={editSession?.recipe ?? null}
                            locked={editorLock}
                            repair={editorRepair}
                            quickSelected={quickSel}
                            onQuickClear={clearQuick}
                            unit={unit.trim()}
                            onReport={handleReport}
                        />
                        <SensorFieldsCard
                            title={editSession ? 'Edit sensor' : 'New sensor'}
                            name={name}
                            setName={setName}
                            nameLocked={editNameLocked}
                            nameLockReason={repairing ? 'The name stays locked while the formula is being fixed.' : editUsage ? describeEditLock(editUsage.editLock, nameOf) : undefined}
                            nameError={editSession ? editNameError : nameError}
                            description={description}
                            setDescription={setDescription}
                            unit={unit}
                            setUnit={setUnit}
                            component={component}
                            setComponent={setComponent}
                            components={componentOptions}
                        />
                    </div>
                </div>
            </div>

            {activeTab === 'manage' && (
                <div className="flex-1 min-h-0 overflow-hidden">
                    <ManageSpecialSensors
                        recipes={manageRecipes}
                        sensorMetadata={sensorMetadata}
                        models={models}
                        usageKnown={failureKnown}
                        runningConditionFilters={runningConditionFilters}
                        selectedSensors={plottedSensors}
                        formulaRefs={formulaRefs}
                        onDelete={handleDeleteSensor}
                        pendingDelete={pendingDelete}
                        onUndo={handleUndoDelete}
                        editingTag={editSession?.recipe.tag ?? null}
                        onEdit={startEdit}
                        savingEdit={savingEdit}
                        unrestored={unrestored}
                    />
                </div>
            )}

            {/* Footer: contextual hint (what's missing, or ready) on the left, actions on the right. */}
            <div className="special-sensor-footer">
                {activeTab === 'create' && editSession ? (
                    <>
                        <span
                            role={editError ? 'alert' : undefined}
                            data-testid="edit-footer-hint"
                            className={`special-sensor-footer-hint${editIssue ? ' is-danger' : ''}`}
                        >
                            {editIssue ?? editHint}
                        </span>
                        <span className="special-sensor-spacer" />
                        {savingEdit && <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>Recomputing…</span>}
                        <button onClick={closeEdit} disabled={savingEdit} className="special-sensor-btn">Cancel edit</button>
                        <button
                            onClick={handleSaveFromEditor}
                            disabled={!canSaveEdit}
                            title={canSaveEdit ? undefined : editBlock ?? undefined}
                            className="special-sensor-btn special-sensor-btn--primary"
                        >
                            Save changes
                        </button>
                    </>
                ) : activeTab === 'create' ? (
                    <>
                        <span
                            role={addError && footerIssue === addError ? 'alert' : undefined}
                            data-testid="create-footer-hint"
                            className={`special-sensor-footer-hint${footerIssue ? ' is-danger' : ''}`}
                        >
                            {footerIssue ?? (isCreatingSomething
                                ? 'Adds a computed sensor to this workspace.'
                                : 'Pick sensors on the left for Quick build, or type a formula.')}
                        </span>
                        <span className="special-sensor-spacer" />
                        <button onClick={handleClose} className="special-sensor-btn">Cancel</button>
                        <button
                            onClick={handleAdd}
                            disabled={!canAdd || adding || !!sessionLost || !!editSession}
                            title={canAdd ? undefined : footerIssue ?? undefined}
                            className="special-sensor-btn special-sensor-btn--primary"
                        >
                            <Plus size={13} /> Add sensor
                        </button>
                    </>
                ) : (
                    <>
                        <span className="special-sensor-spacer" />
                        <button onClick={handleClose} className="special-sensor-btn">Close</button>
                    </>
                )}
            </div>

            {toast && (
                <div
                    className="text-xs rounded shadow-lg"
                    style={{
                        position: 'absolute',
                        bottom: 16,
                        right: 16,
                        padding: '10px 14px',
                        maxWidth: 380,
                        backgroundColor: 'var(--card-bg)',
                        border: `1px solid ${toast.kind === 'error' ? 'var(--danger)' : 'var(--ok)'}`,
                        color: toast.kind === 'error' ? 'var(--danger)' : 'var(--ok)',
                    }}
                    role={toast.kind === 'error' ? 'alert' : 'status'}
                >
                    {toast.kind === 'error' ? '' : '✓ '}{toast.message}
                </div>
            )}
        </div>
        </SensorMetaProvider>
    );
}
