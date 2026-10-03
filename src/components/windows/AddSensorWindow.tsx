import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { X, Plus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { subscribe } from "../../utils/tauriEvents";
import {
    FailureModel, FailureGroupStateChangedPayload, SensorMetadata, SensorOperationConfig,
    SpecialSensorRecipe, WorkspaceSensorFilter,
} from "../../types";
import SensorExplorer from "./SensorExplorer";
import SensorTooling from "./SensorTooling";
import ManageSpecialSensors from "./ManageSpecialSensors";
import { debugLog } from "../../utils/debugLog";
import {
    buildSpecialSensorUsage, reorderRecipesByTags, usageFor, SpecialSensorUsage,
} from "../../utils/specialSensorDeps";
import { EditFailureState, runSpecialSensorEdit, SpecialSensorEditError } from "../../utils/specialSensorEdit";
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

/** How long a deleted special sensor can still be brought back. Nothing has
 *  left this window yet during that time -- see `commitDeleteRaw`. */
const UNDO_WINDOW_MS = 8000;

/** What a rejected `invoke` carries, as text for the user. Tauri rejects with
 *  the command's `Err(String)` itself, not an `Error`. */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type ToastKind = 'ok' | 'error';

/**
 * `useState` whose latest value is ALSO readable synchronously through a ref.
 * The serial queue's tasks must see what the previous task just wrote, and a
 * task that awaits cannot trust a `state` variable captured at the render it
 * started in -- so the lists tasks reason about live here.
 */
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

/** Everything the Create form held when "Add sensor" was clicked. The task is
 *  queued, so it must not read the form later -- the user may have moved on. */
interface CreateSnapshot {
    formulaMode: boolean;
    formulaExpression: string;
    formulaCustomName: string;
    operationConfig: SensorOperationConfig | null;
    selectedSensors: string[];
    description: string;
    unit: string;
    component: string;
    /** Would this create a new derived sensor (vs. adding raw sensors as-is)? */
    creating: boolean;
    name: string;
}

/**
 * What a queued task is bound to, captured when it is ENQUEUED (never read
 * later from the refs, which move on when the window is re-pointed):
 *  - `epoch`: the window's invalidation counter. Anything that makes the work
 *    in flight no longer belong here (re-pointed to another project/dataset,
 *    its project closed, the Rust session found stale) bumps it; a task
 *    re-checks it after every await and stops silently if it moved.
 *  - `workspaceId` / `generation`: the project and Rust dataset this window
 *    was handed. Every emit is tagged with the captured id, and every guarded
 *    Rust command carries the captured generation (`expectedGeneration`), so
 *    even a task that is already past its last check cannot mutate another
 *    project's session.
 */
interface TaskCtx {
    epoch: number;
    workspaceId: string | undefined;
    generation: number | undefined;
}

/** One short sentence: what still uses a sensor that was about to be deleted. */
function describeUsage(usages: SpecialSensorUsage[]): string {
    const parts: string[] = [];
    for (const u of usages) {
        if (u.dependentSensors.length > 0) parts.push(`${u.dependentSensors.join(', ')} (built on it)`);
        if (u.modelReferences.length > 0) {
            parts.push(u.modelReferences.map(r => `${r.modelName || 'Untitled model'} (${r.field})`).join(', '));
        }
        if (u.runningCondition) parts.push('the workspace Running condition');
    }
    return parts.join('; ');
}

export default function AddSensorWindow() {
    // Everything the serial queue's tasks reason about lives in `useRefState`:
    // the state drives rendering, the ref is what a task reads (always the
    // value the PREVIOUS task left behind, never a stale render's copy).
    const [sensors, setSensors, sensorsRef] = useRefState<string[]>([]);
    const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
    // What the dashboard chart is currently plotting. Distinct from
    // `selectedSensors` above, which is this window's own picker (deliberately
    // left empty on open -- see the sensors-data handler).
    // A MIRROR of the Dashboard's selection, used only for the Manage tab's
    // "on chart" badge. It is seeded by `sensors-data` and then set from what
    // the Dashboard REPORTS it plotted (`add-sensor-plot-result`) -- never
    // inferred from what this window asked for: the Dashboard may refuse (Pair
    // Plot's 4-sensor cap), and a guessed mirror showed a badge for a sensor
    // that was not on the chart.
    const [plottedSensors, setPlottedSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useRefState<SensorMetadata[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [operationConfig, setOperationConfig] = useState<SensorOperationConfig | null>(null);
    const [description, setDescription] = useState('');
    const [unit, setUnit] = useState('');
    const [component, setComponent] = useState('');
    // Bumped after a successful Add: SensorTooling is remounted with it, which
    // clears ALL of its own state (mode, picked operation / chain, formula
    // text, Name, Description/Unit/Component). Resetting only this window's
    // copy left the tooling still showing -- and re-submitting -- the old
    // formula and name ("A sensor named 'Once' already exists" right after a
    // successful add).
    const [formKey, setFormKey] = useState(0);

    // Formula mode state
    const [formulaMode, setFormulaMode] = useState(false);
    const [formulaExpression, setFormulaExpression] = useState('');
    const [formulaCustomName, setFormulaCustomName] = useState('');

    // "Add sensor" creates immediately and keeps the window open (see
    // handleAdd). `adding` is its own flag -- NOT `loading`, which swaps the
    // whole explorer for "Loading..." and is only for the initial data -- so
    // the button can lock without the picker flickering away. The ref is the
    // real double-click guard: state would still read false for a second
    // click that lands before React re-renders.
    const [adding, setAdding] = useState(false);
    const addingRef = useRef(false);
    // Why the last Add failed (from the backend), shown inline in the footer.
    const [addError, setAddError] = useState<string | null>(null);
    // Names the backend refused as "already exists" even though this window
    // didn't know of them (a column it was never told about). Treated as taken
    // so the Name field shows the conflict instead of letting the same click
    // fail again.
    const [rejectedNames, setRejectedNames, rejectedRef] = useRefState<string[]>([]);

    const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showToast = useCallback((message: string, kind: ToastKind = 'ok') => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ message, kind });
        // A failure has to stay up long enough to read.
        toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 7000 : 2200);
    }, []);

    // UI State
    const [searchTerm, setSearchTerm] = useState("");
    const [activeTab, setActiveTab] = useState<'create' | 'manage'>('create');

    // Everything the Manage tab needs. `recipes` is this window's own copy of
    // the dashboard's `specialSensorRecipes` -- it arrives with sensors-data,
    // grows as sensors are created here, and shrinks as they are deleted.
    const [recipes, setRecipes, recipesRef] = useRefState<SpecialSensorRecipe[]>([]);
    // Workspace the last `sensors-data` belonged to -- every task captures it
    // when it is queued and stamps it on its emits (see `TaskCtx`).
    const workspaceIdRef = useRef<string | undefined>(undefined);
    // The Rust dataset generation the Dashboard handed over with it. Sent as
    // `expectedGeneration` on every guarded command, so a window that outlives
    // its project cannot mutate the next project's session.
    const generationRef = useRef<number | undefined>(undefined);
    // Bumped whenever work in flight stops belonging to this window's current
    // project (re-pointed, project closed, session found stale).
    const epochRef = useRef(0);
    // Has a `sensors-data` ever bound this window?
    const boundRef = useRef(false);
    // Set when this window learned its dataset is gone (project closed or the
    // session replaced). Mutations are refused until a NEWER `sensors-data`
    // re-binds it; `lostAtGenerationRef` is what "newer" is measured against.
    const [sessionLost, setSessionLost] = useState<string | null>(null);
    const sessionLostRef = useRef(false);
    const lostAtGenerationRef = useRef<number | undefined>(undefined);
    // Newest models re-read wins (also bumped on every invalidation).
    const refreshSeq = useRef(0);
    const [models, setModels, modelsRef] = useRefState<FailureModel[]>([]);
    // The workspace Running condition's conditions: naming a special sensor
    // there blocks deleting it (and a rename has to carry through).
    const [runningConditionFilters, setRunningConditionFilters, rcRef] = useRefState<WorkspaceSensorFilter[]>([]);
    // Whether `models` / `runningConditionFilters` are KNOWN fresh. Until they
    // are (never received, or the last re-read from disk failed) deletion is
    // blocked: "nothing uses it" would be a guess, and a delete drops the
    // column for real.
    const [failureKnown, setFailureKnown] = useState(false);
    // Formula tag -> sensors it references, from Rust. Null until the lookup
    // answers; Manage refuses to delete anything while it is null, because an
    // empty map would look exactly like "nothing depends on anything".
    // (Only a UI hint -- every mutation re-reads references itself, inside the
    // queue, instead of trusting this cache.)
    const [formulaRefs, setFormulaRefs] = useState<Map<string, string[]> | null>(null);

    // ---- The serial queue ---------------------------------------------------
    // Create, edit/rename and delete-commit all read the session, write
    // columns, and then tell the Dashboard. Run two at once and one reads (or
    // overwrites) what the other is half-way through writing. So they run one
    // at a time, each against the state the previous one left, and every
    // check (name taken? still in use? would that be a cycle?) happens INSIDE
    // the task, against fresh state -- not at click time.
    const queue = useMemo(() => createSerialQueue(), []);
    const [busy, setBusy] = useState(false);
    useEffect(() => queue.subscribe(n => setBusy(n > 0)), [queue]);

    // ---- Deletions (undo window) ---------------------------------------------
    // A deletion is applied in two steps. Click: the sensor disappears from
    // every list here at once ("hidden") but nothing leaves the window and no
    // column is dropped -- Undo costs nothing. After UNDO_WINDOW_MS (or when
    // something needs the name/sources settled, or the window closes) a
    // commit task is queued; it re-checks what uses the sensor against FRESH
    // state, and only then drops the column and tells the Dashboard.
    const deletionsRef = useRef<Deletion[]>([]);     // every hidden, unfinished deletion
    const slotRef = useRef<Deletion | null>(null);   // the one that can still be undone
    const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [hiddenTags, setHiddenTags] = useState<string[]>([]);
    const [pendingDelete, setPendingDelete] = useState<{ tags: string[]; label: string } | null>(null);

    // Which row has its editor open, and how the last save attempt went.
    const [editingTag, setEditingTag] = useState<string | null>(null);
    const [savingEdit, setSavingEdit] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    const syncHidden = () => setHiddenTags(deletionsRef.current.flatMap(d => d.tags));
    const isHidden = (tag: string) => deletionsRef.current.some(d => d.tags.some(t => sameTag(t, tag)));

    // ---- Window epoch ---------------------------------------------------------
    // Everything below belongs to "the project this window is bound to". When
    // that stops being true the epoch moves; a queued/in-flight task that
    // captured an older one aborts silently (it neither retries nor rolls back
    // -- the data in the session is not ours any more).
    const captureCtx = (): TaskCtx => ({
        epoch: epochRef.current,
        workspaceId: workspaceIdRef.current,
        generation: generationRef.current,
    });
    const isCurrent = (ctx: TaskCtx) => ctx.epoch === epochRef.current;
    const assertCurrent = (ctx: TaskCtx) => { if (!isCurrent(ctx)) throw new TaskAbortedError(); };

    /** The Tauri `invoke` for one task: stamps `expectedGeneration` on the
     *  guarded commands, turns Rust's STALE_SESSION refusal into a typed error,
     *  and refuses to even start (or to hand back a result) once the window's
     *  epoch has moved on. */
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

    /** Stop everything in flight: bump the epoch, cancel every pending deletion
     *  (the one in its undo window is dropped, never committed), invalidate
     *  in-flight models re-reads. Does NOT touch the form. */
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

    /** A different project / dataset (or a recovery from "lost"): drop ALL of the
     *  old binding's state -- form, open editor, queued work, errors. */
    const resetForRebind = () => {
        invalidateWork();
        sessionLostRef.current = false;
        lostAtGenerationRef.current = undefined;
        setSessionLost(null);
        setSelectedSensors([]);
        setOperationConfig(null);
        setFormulaMode(false);
        setFormulaExpression('');
        setFormulaCustomName('');
        setDescription('');
        setUnit('');
        setComponent('');
        setFormKey(k => k + 1);
        setRejectedNames([]);
        setAddError(null);
        setSearchTerm('');
        setActiveTab('create');
        setEditingTag(null);
        setEditError(null);
        setFormulaRefs(null);
        setFailureKnown(false);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(null);
    };

    /** A task failed with `err`. True when it was only because this window's
     *  dataset is gone (already handled: nothing more to do or show). */
    const handleSessionLoss = (ctx: TaskCtx, err: unknown): boolean => {
        // Re-pointed / closed since this task was queued: stay silent, the
        // window may well be healthy for its NEW project.
        if (!isCurrent(ctx)) return true;
        if (err instanceof StaleSessionError) { markSessionLost(); return true; }
        return err instanceof TaskAbortedError;
    };

    /** Re-read the models and Running condition from the workspace file. With a
     *  `ctx` it reads THAT task's workspace and aborts if the window moved on
     *  while the file was being read. */
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

    // Broadcast arrival order is not guaranteed (two windows can write and
    // emit close together), so a payload is never trusted as "the latest":
    // every broadcast just triggers a re-read of the file (writers persist
    // BEFORE they emit), and only the newest re-read may apply (`refreshSeq`,
    // which every invalidation bumps too -- a re-read of the OLD project's
    // file can never land on the new one).
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
            // 1. Listen for data from Dashboard (Rich data with metadata)
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
                    // MONOTONIC RULE: the Rust generation only ever grows, so a
                    // payload OLDER than what this window already holds comes
                    // from a Dashboard that no longer exists (a copy delayed in
                    // transit). Re-pointing the window backwards to it would
                    // hand a dead project's recipes to the live session.
                    if (incomingGeneration !== undefined && boundGeneration !== undefined && incomingGeneration < boundGeneration) return;
                    // Once the dataset was lost, only a STRICTLY newer one may
                    // re-bind (the same generation is the dead Dashboard again).
                    const lostAt = lostAtGenerationRef.current;
                    if (sessionLostRef.current && incomingGeneration !== undefined && lostAt !== undefined && incomingGeneration <= lostAt) return;
                    // A different project, a different dataset (same project
                    // reopened), or a recovery from "lost": nothing of the old
                    // binding survives -- form, editor, queue, deletions.
                    const differentProject = event.payload.workspaceId !== workspaceIdRef.current;
                    const differentDataset = incomingGeneration !== undefined && boundGeneration !== undefined && incomingGeneration !== boundGeneration;
                    if (differentProject || differentDataset || sessionLostRef.current) resetForRebind();
                }
                boundRef.current = true;
                // This window belongs to whichever workspace/dataset it was last
                // handed data for; every task captures them when queued, tags its
                // emits with that workspace id and pins that generation on every
                // guarded Rust command.
                workspaceIdRef.current = event.payload.workspaceId;
                generationRef.current = incomingGeneration;
                setSensors(event.payload.sensors);
                // Deliberately NOT pre-checking `event.payload.selectedSensors`
                // (whatever's currently plotted on the Dashboard chart) --
                // this window always starts with a clean, empty picker.
                // Pre-checking used to be harmless, but combined with the
                // default "+" chain (see useCalculationEngine), reopening
                // this window right after adding a sensor would pre-check
                // the same inputs AND show an already-active calculation
                // ready to submit -- indistinguishable from the screen right
                // before the previous "Add sensor" click, which read as "did
                // my sensor not get added?".
                setSensorMetadata(event.payload.sensorMetadata);
                setPlottedSensors(event.payload.selectedSensors ?? []);
                setRecipes(event.payload.specialSensorRecipes ?? []);
                setModels(event.payload.models ?? []);
                setRunningConditionFilters(event.payload.runningConditionFilters ?? []);
                setFailureKnown(Array.isArray(event.payload.models));
                setLoading(false);
            });

            // The Dashboard that bound this window is going away (Back to
            // Import / another project opening). Defence in depth next to the
            // Dashboard's own close of this window: if that close is lost or
            // late, drop everything NOW instead of trusting it. Scoped to the
            // workspace AND dataset this window holds -- a late copy for an
            // earlier project must not kill a window already re-pointed.
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

            // 2. Request data
            await emit('request-sensors');

            // 3. Fallback logic
            try {
                const allHeaders = await invoke<string[]>('get_all_sensors');
                // Never reload the CSV from here: this window shares ONE Rust
                // session with the Dashboard, and `load_csv` would replace it
                // (dropping every computed column and invalidating the
                // generation this window is bound to). An empty session just
                // means the Dashboard's `sensors-data` has not arrived yet.
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

    // Keep `models` and the Running condition current. They arrive with
    // `sensors-data` once, when the window opens -- but this window can stay
    // open while the user assigns a special sensor to a model in Build Model,
    // and delete-protection reads them. A stale list would let a sensor a model
    // now uses be deleted, and since a delete drops the column for real, that
    // model would be left pointing at data that is gone. Same workspace-scoped
    // broadcast Dashboard and Build Model use; one without OUR workspace id is
    // foreign. The payload itself is NOT applied (arrival order is not
    // guaranteed) -- it only says "something changed, look again".
    useEffect(() => {
        const off = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            const id = workspaceIdRef.current;
            if (!id || event.payload?.workspaceId !== id) return;
            refreshFailureState();
        });
        return () => off();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // What the Dashboard REALLY plotted after an add (it merges into its own
    // current selection and applies Pair Plot's cap) -- see `plottedSensors`.
    useEffect(() => {
        const off = subscribe<{ workspaceId?: string; selectedSensors?: string[] }>('add-sensor-plot-result', (event) => {
            const id = workspaceIdRef.current;
            if (!id || event.payload?.workspaceId !== id) return;
            if (Array.isArray(event.payload.selectedSensors)) setPlottedSensors(event.payload.selectedSensors);
        });
        return () => off();
    }, []);

    // Ask Rust which sensors each formula references. Done here rather than
    // with a substring scan in TypeScript because sensor names nest: `test` is
    // a substring of `test extend`, so `formula.includes(tag)` would report a
    // dependency that isn't there and leave `test` permanently undeletable.
    // `extract_formula_refs` reuses the evaluator's own parser.
    useEffect(() => {
        const formulaRecipes = recipes.filter(r => r.kind === 'formula');
        if (formulaRecipes.length === 0) {
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

    // ---- Delete: commit (runs INSIDE the queue) -------------------------------

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

    /**
     * Actually delete, against FRESH state. The Delete button was enabled at
     * click time, but up to UNDO_WINDOW_MS (plus any queue wait) has passed:
     * another window may since have made the sensor a model's target, put it in
     * the Running condition, or built another special sensor on it. Dropping
     * its column then would leave that model/filter/sensor pointing at data
     * that is gone (and Rust silently ignores an unknown filter sensor, so
     * models would train on different rows with no error). So the dependents
     * are re-read here; if something uses it now the delete is CANCELLED, the
     * sensor reappears in the list, and the user is told why.
     */
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
            if (used.length > 0) blocked = `it is now used by ${describeUsage(used)}`;
        } catch (err) {
            // Re-pointed / closed while re-reading: this deletion belongs to a
            // project that is not on screen any more -- never touch the session.
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
        setSelectedSensors(prev => prev.filter(t => !gone(t)));
        setPlottedSensors(prev => prev.filter(t => !gone(t)));
        setRejectedNames(prev => prev.filter(n => !gone(n)));
        // Drop the computed column(s) from the Rust session FIRST. Without
        // this the column outlived its sensor, and a new sensor created under
        // the same name was read back as the OLD one's numbers. A failure here
        // must not strand the UI half-deleted, so the removal below still
        // finishes -- but it is surfaced, because the name stays taken in the
        // session until the app restarts.
        try {
            await inv('remove_sensor_columns', { names: tags });
        } catch (err) {
            // Stale dataset / re-pointed window: the columns in the session are
            // not this window's -- nothing was removed, and nothing is announced.
            if (isSessionLostError(err)) throw err;
            console.error('Failed to drop the deleted sensor column(s) from the session:', err);
            showToast(
                `Removed ${tags.join(', ')} from the workspace, but couldn't free its data (${errorText(err)}). `
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

    /** Queue `d`'s commit (undo window expired, a newer delete replaced it, or
     *  the window is closing). Resolves when it has been applied. */
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
        const d: Deletion = { tags: [tag], label: tag, cancelled: false, started: false, queued: false };
        deletionsRef.current = [...deletionsRef.current, d];
        slotRef.current = d;
        setPendingDelete({ tags: d.tags, label: d.label });
        // A hidden sensor must not stay a source of the form being filled in.
        setSelectedSensors(prev => prev.filter(t => !sameTag(t, tag)));
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

    /** Rows the Manage tab shows: a sensor inside its undo window is already
     *  gone from here, which is also what unlocks anything built on top of
     *  it for deletion in the same breath. */
    const manageRecipes = useMemo(() => {
        if (hiddenTags.length === 0) return recipes;
        return recipes.filter(r => !hiddenTags.some(t => sameTag(t, r.tag)));
    }, [recipes, hiddenTags]);

    /** Every sensor tag still in play: `sensors` minus anything deleted but
     *  not yet applied. It feeds EVERY source picker (Explorer, formula
     *  autocompletion, the editor's source list): a sensor inside its undo
     *  window must not be selectable as the source of a new one -- its column
     *  is dropped when the delete commits. A name freed by a pending delete is
     *  usable straight away -- the delete is settled before the sensor is
     *  created. */
    const liveSensors = useMemo(() => {
        if (hiddenTags.length === 0) return sensors;
        return sensors.filter(s => !hiddenTags.some(t => sameTag(t, s)));
    }, [sensors, hiddenTags]);

    // ---- Edit / rename (runs INSIDE the queue) --------------------------------

    /**
     * Save an edited special sensor -- including a rename (the Name field is
     * not locked; `renamedFrom` is set when it changed).
     *
     * Editing is not a local change. The sensor's column was computed once and
     * lives in the Rust session; changing the recipe means recomputing it, and
     * anything built on top of it was computed from the OLD values and is
     * stale the moment this lands. The backend half -- find what is built on
     * it, recompute it and every downstream recipe in BUILD order, roll back if
     * any step fails -- is `runSpecialSensorEdit` (specialSensorEdit.ts).
     *
     * A rename adds steps around that. Before it, every OTHER recipe that
     * still names the OLD tag has to be rewritten to the new one; after it, the
     * Dashboard is told (it re-keys everything it holds by tag: selection,
     * colours, axes, highlights, Filter tab, models, Running condition), and
     * LAST the OLD column is removed -- the recompute writes the sensor under
     * its NEW name only, and the old column would otherwise sit in the session
     * forever, still holding the old values and blocking the old name. It is
     * last so a failure anywhere earlier can never leave a recipe pointing at a
     * column that is gone. (Skipped when the name only changed case: Rust
     * overwrites that very column in place, and removing "the old one" would
     * delete the new.)
     *
     * Refused rather than repaired afterwards: a formula that references
     * nothing, one that makes the sensor depend on itself (directly or through
     * the chain), and a rename that collides with another sensor's tag.
     *
     * EDIT LOCK (2026-10-03, user decision): a sensor that a model -- or the
     * workspace Running condition, or a special sensor built on it that one of
     * them uses -- depends on may not be renamed nor have its values changed
     * (only description / unit / component). The models are RE-READ FROM DISK
     * at the start of this task (same as the delete commit), so a model added
     * from another window after the click still refuses the edit; the check
     * runs inside `runSpecialSensorEdit`'s read-only phase, before any column
     * is touched. A model that starts using the sensor WHILE a task is already
     * past that check is not stopped (it can only have picked the new values).
     */
    const saveEditTask = async (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string }, ctx: TaskCtx) => {
        const oldTag = next.renamedFrom;
        const newTag = next.recipe.tag;
        const removesOldColumn = !!oldTag && !sameTag(oldTag, newTag);
        const inv = invokerFor(ctx);
        try {
            // Any deletion still waiting is settled first, so the dependency
            // graph this reasons about matches what the dashboard holds.
            await settleDeletions(ctx);

            // Fresh models + Running condition for the edit lock. Unreadable =
            // treated as locked (a guess of "nothing uses it" is how a trained
            // model goes stale).
            let failureState: EditFailureState;
            try {
                const fresh = await readFailureState(ctx);
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

            const outcome = await runSpecialSensorEdit({
                recipes: recipesRef.current,
                next: next.recipe,
                oldTag,
                invoker: inv,
                failureState,
            });
            assertCurrent(ctx);
            const { downstream, renamedDownstream, recipeOrder, applyEdit } = outcome;
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
                setSelectedSensors(prev => renameTagInArray(prev, oldTag, newTag));
                setPlottedSensors(prev => renameTagInArray(prev, oldTag, newTag));
                // This window's own copies follow at once (the Dashboard
                // re-keys the persisted ones and broadcasts, but that lands
                // later -- until then the renamed sensor would look unused and
                // could be deleted from under the model / condition using it).
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
                await emit('update-special-sensor', {
                    recipe: savedRecipe,
                    metadata: next.metadata,
                    recomputed: outcome.metadataOnly ? [] : [next.recipe.tag, ...downstream.map(r => r.tag)],
                    recipeOrder,
                    workspaceId: ctx.workspaceId,
                    generation: ctx.generation,
                });
            }

            // LAST: everything above succeeded and the Dashboard now knows the
            // new name, so nothing refers to the old column any more. A failure
            // here is not a failed rename -- it only leaves an orphan column
            // behind -- so it is reported, not thrown.
            let cleanupWarning: string | null = null;
            if (removesOldColumn && oldTag) {
                try {
                    await inv('remove_sensor_columns', { names: [oldTag] });
                } catch (err) {
                    if (isSessionLostError(err)) throw err;
                    console.error('Failed to drop the old column after a rename:', err);
                    cleanupWarning = `Renamed "${oldTag}" to "${newTag}", but couldn't free the old data (${errorText(err)}). `
                        + `Creating a sensor named "${oldTag}" may fail until the app is restarted.`;
                }
            }

            setEditingTag(null);
            if (cleanupWarning) {
                showToast(cleanupWarning, 'error');
            } else {
                showToast(
                    oldTag
                        ? `Renamed "${oldTag}" to "${newTag}"${downstream.length > 0 ? ` — updated ${downstream.length} sensor(s) built on it` : ''}`
                        : downstream.length > 0
                            ? `Updated ${next.recipe.tag} — recomputed ${downstream.length} sensor(s) built on it`
                            : `Updated ${next.recipe.tag}`,
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
                    message += ` The previous values of ${err.inconsistent.join(', ')} could not be restored, `
                        + 'so they may show wrong numbers. Reopen the workspace to rebuild them.';
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
        setSavingEdit(true);
        setEditError(null);
        void runTask(ctx => saveEditTask(next, ctx))
            .catch(err => {
                if (isSessionLostError(err)) return;
                console.error('Edit failed:', err);
                if (epoch === epochRef.current) setEditError(errorText(err));
            })
            .finally(() => { if (epoch === epochRef.current) setSavingEdit(false); });
    };

    const handleClose = async () => {
        // A deletion still mid-undo has not left this window yet; closing is
        // the user saying they meant it, so make it real before the window
        // goes. It queues behind anything in flight, and so does the wait.
        const d = slotRef.current;
        if (d) await scheduleCommit(d);
        await queue.idle();
        await getCurrentWindow().close();
    };

    // Whether the current selection/operation would actually create a new
    // derived sensor (needs a name) vs. just adding the raw sensor(s)
    // through as-is (nothing to name). Mirrors SensorTooling's own
    // `creatingSomething`, computed here from the same config/formula state
    // it reports up via onConfigChange/onFormulaSubmit.
    const isCreatingSomething = (formulaMode && formulaExpression.trim() !== '') || operationConfig !== null;
    const currentName = formulaMode ? formulaCustomName : (operationConfig?.customName ?? '');

    // Every tag a NEW sensor's name must not equal: imported columns and
    // existing special sensors (both are in `liveSensors`; the recipes are
    // listed too so a recipe whose tag somehow isn't in the sensor list still
    // counts), plus names the backend already turned down. Compared trimmed and
    // case-insensitively -- exactly how the Rust side decides "already exists".
    const takenTags = useMemo(
        () => [...liveSensors, ...manageRecipes.map(r => r.tag), ...rejectedNames],
        [liveSensors, manageRecipes, rejectedNames],
    );
    const nameError = isCreatingSomething ? nameProblem(currentName, takenTags) : null;

    // Name + Description + Unit + Component must all be filled in before a
    // new sensor can be added -- previously only Name was checked (and only
    // on click, via a flash message), so "Add sensor" stayed clickable with
    // Unit/Component left blank; the sensor was then silently created with
    // an empty unit and "Uncategorized" as its component. Blank when nothing
    // is actually being created (adding raw sensor(s) through as-is has
    // nothing to name).
    const missingCreateFields = isCreatingSomething
        ? [
            !currentName.trim() && 'a name',
            !description.trim() && 'a description',
            !unit.trim() && 'a unit',
            !component.trim() && 'a component',
        ].filter((f): f is string => !!f)
        : [];
    const canAdd = missingCreateFields.length === 0 && !nameError;
    // The one line the footer shows in the Create tab, most actionable first:
    // a bad name, then what's still blank, then why the last attempt failed.
    const footerIssue = nameError
        ? 'Fix the name before adding.'
        : (missingCreateFields.length > 0 ? `Fill in ${missingCreateFields.join(', ')} before adding.` : addError);

    // A failed Add's message belongs to THAT attempt: once anything the user
    // could change to fix it changes, it no longer applies. Keyed on the
    // serialized inputs (not object identity) so a re-render that merely
    // re-reports an identical config can't wipe the message the instant it
    // appears.
    const attemptKey = JSON.stringify([selectedSensors, formulaMode, formulaExpression, formulaCustomName, operationConfig]);
    useEffect(() => {
        setAddError(null);
    }, [attemptKey]);

    // ---- Create (runs INSIDE the queue) ---------------------------------------

    /**
     * Run whatever calculation was configured (formula, legacy config, or none
     * -- "add as-is") and return what the Dashboard should plot, the
     * master-data metadata (description/unit/component) for the newly created
     * sensor -- the same fields a mapping CSV row supplies for an imported
     * sensor -- and its recipe.
     *
     * `plotSensors` is what gets ADDED to the Dashboard's plot: the new
     * sensor's own tag when one was created (never the sensors it was built
     * from -- those are inputs, not something the user asked to see), or the
     * picked raw sensors when nothing was created ("add as-is").
     *
     * 2026-09-01: the recipe is new -- Rust's `calculate_new_sensor`/
     * `evaluate_formula` compute the new column ONCE and push it straight
     * onto the in-memory session (`AppState.data`); nothing before this
     * persisted anything that could recreate it, so the column was
     * silently gone after every app restart even though its name/
     * description survived (see `newMetadata`). The recipe is exactly
     * what's needed to invoke the same command again after a workspace
     * reopen -- see `WorkspaceState.specialSensorRecipes`.
     */
    const computeRound = async (snap: CreateSnapshot, inv: Invoker): Promise<{ plotSensors: string[]; newMetadata: SensorMetadata[]; newRecipes: SpecialSensorRecipe[] }> => {
        if (snap.formulaMode && snap.formulaExpression.trim()) {
            const newSensorName = await inv('evaluate_formula', {
                formula: snap.formulaExpression,
                customName: snap.formulaCustomName.trim() || null,
            }) as string;
            return {
                plotSensors: [newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: snap.description.trim() || snap.formulaCustomName.trim(),
                    unit: snap.unit.trim(),
                    component: snap.component.trim() || 'Uncategorized',
                }],
                newRecipes: [{ kind: 'formula', tag: newSensorName, formula: snap.formulaExpression }],
            };
        }
        if (snap.operationConfig) {
            const newSensorName = await inv('calculate_new_sensor', {
                sensors: snap.selectedSensors,
                config: snap.operationConfig,
            }) as string;
            return {
                plotSensors: [newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: snap.description.trim() || (snap.operationConfig.customName ?? '').trim(),
                    unit: snap.unit.trim(),
                    component: snap.component.trim() || 'Uncategorized',
                }],
                newRecipes: [{ kind: 'operation', tag: newSensorName, sourceSensors: snap.selectedSensors, operationConfig: snap.operationConfig }],
            };
        }
        return { plotSensors: snap.selectedSensors, newMetadata: [], newRecipes: [] };
    };

    const createSensor = async (snap: CreateSnapshot, ctx: TaskCtx) => {
        const attemptedName = snap.name.trim();
        const inv = invokerFor(ctx);

        // A name that is only taken by a sensor still waiting to be deleted:
        // settle that delete first (drops its column) or the backend would
        // refuse the name as "already exists".
        if (attemptedName) await settleDeletions(ctx, d => d.tags.some(t => sameTag(t, attemptedName)));

        // Re-check the name against FRESH state: while this waited its turn, an
        // edit/rename may have taken it (a rename would otherwise be
        // overwritten by this create, leaving two recipes with one name).
        if (snap.creating) {
            const taken = [
                ...sensorsRef.current.filter(s => !isHidden(s)),
                ...recipesRef.current.filter(r => !isHidden(r.tag)).map(r => r.tag),
                ...rejectedRef.current,
            ];
            const problem = nameProblem(snap.name, taken);
            if (problem) throw new Error(problem);
        }

        // A source that is deleted-but-not-applied (typed into a formula by
        // hand -- the pickers do not offer it) would be built on, then have its
        // column dropped from under the new sensor.
        if (deletionsRef.current.length > 0) {
            let used: string[] = snap.selectedSensors;
            if (snap.creating && snap.formulaMode) {
                const out = await inv('extract_formula_refs', { formulas: [snap.formulaExpression] }) as string[][];
                used = out?.[0] ?? [];
            }
            const hiddenSource = used.find(isHidden);
            if (hiddenSource !== undefined) {
                throw new Error(`"${hiddenSource}" is being deleted. Undo that first, or pick another sensor.`);
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

        // `sensors` is a delta -- what the Dashboard should ADD to its
        // plot -- see `AddSensorSelectionPayload`. The Dashboard answers with
        // what it actually plotted (`add-sensor-plot-result`).
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
            showToast(`Created ${createdName ?? 'the sensor'}, but couldn't tell the dashboard (${errorText(err)}). Reopen the workspace to see it.`, 'error');
        }

        showToast(createdName ? `Added: ${newMetadata[0].description || createdName}` : `Added ${plotSensors.length} sensor(s)`);

        // Reset the form for the next round -- this window's copy AND the
        // tooling's (remounted through `formKey`).
        setSelectedSensors([]);
        setOperationConfig(null);
        setFormulaMode(false);
        setFormulaExpression('');
        setFormulaCustomName('');
        setDescription('');
        setUnit('');
        setComponent('');
        setFormKey(k => k + 1);
    };

    // Queues the sensor currently configured, tells Dashboard about it as soon
    // as it is built (so the chart updates immediately), clears the form for
    // the next one, and keeps the window open -- there's no separate "finish"
    // step; "Close" just closes once the user is done adding sensors.
    const handleAdd = () => {
        // The button is disabled in these states, so this only matters for a
        // second click that lands before React has re-rendered it disabled --
        // which would otherwise create twice (or hit the new duplicate-name
        // error on a sensor that was in fact created fine).
        if (sessionLostRef.current) { setAddError(STALE_SESSION_MESSAGE); return; }
        if (addingRef.current || !canAdd) return;
        addingRef.current = true;
        setAdding(true);
        setAddError(null);
        const snap: CreateSnapshot = {
            formulaMode, formulaExpression, formulaCustomName, operationConfig,
            selectedSensors: selectedSensors.filter(t => !isHidden(t)),
            description, unit, component,
            creating: isCreatingSomething,
            name: currentName,
        };
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
                // The window didn't know of this name but the backend does (a
                // race, or a column this window was never told about): remember
                // it so the Name field flags it instead of letting the same
                // click fail again.
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

    const handleSensorToggle = (sensor: string) => {
        setSelectedSensors(prev => {
            if (prev.includes(sensor)) {
                return prev.filter(s => s !== sensor);
            } else {
                return [...prev, sensor];
            }
        });
    };

    const handleFormulaSubmit = useCallback((formula: string, customName?: string) => {
        setFormulaMode(true);
        setFormulaExpression(formula);
        setFormulaCustomName(customName || '');
    }, []);

    const handleConfigChange = useCallback((config: SensorOperationConfig | null) => {
        setFormulaMode(false);
        setOperationConfig(config);
    }, []);

    const filteredSensors = useMemo(() => {
        if (!searchTerm) return liveSensors;
        const lowerTerm = searchTerm.toLowerCase();
        return liveSensors.filter(s => {
            const meta = sensorMetadata?.find(m => m.tag === s);
            const searchStr = meta
                ? `${s} ${meta.description} ${meta.component} ${meta.unit}`.toLowerCase()
                : s.toLowerCase();
            return searchStr.includes(lowerTerm);
        });
    }, [liveSensors, searchTerm, sensorMetadata]);


    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', position: 'relative' }}>
            {/* Header — matches View Table dialog (.pair-regl-modal-header) */}
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center" style={{ gap: '14px' }}>
                    <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Special Sensors</h2>
                    {/* Tabs — creating and managing are the same window because
                        the two are the same job: you build a sensor, then you
                        want to see what you built and get rid of what you no
                        longer use. Moved next to the title (matching the
                        approved prototype's header-level segmented tab pair)
                        instead of a separate row below it. */}
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

            {/* The dataset this window was opened for is gone (its project was
                closed or reloaded). Nothing here can change anything until the
                Dashboard re-sends its data (Add Special Sensor button). */}
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

            {/* Main content — fixed 320px left column (Explorer) + flexible
                right column (Tooling), matching the approved prototype's own
                `.fv` grid. Kept mounted while the Manage tab is showing (just
                hidden via `display`), same as before. */}
            <div
                className="special-sensor-body"
                aria-busy={adding || undefined}
                style={{ display: activeTab === 'create' ? 'grid' : 'none', ...(adding ? { pointerEvents: 'none', opacity: 0.7 } : null) }}
            >
                {/* Left: Explorer */}
                <div className="special-sensor-left">
                    {loading ? (
                        <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
                    ) : (
                        <SensorExplorer
                            sensors={filteredSensors}
                            sensorMetadata={sensorMetadata}
                            selectedSensors={selectedSensors}
                            onToggleSensor={handleSensorToggle}
                            searchTerm={searchTerm}
                            onSearchChange={setSearchTerm}
                        />
                    )}
                </div>

                {/* Right: Tooling */}
                <div className="special-sensor-right custom-scrollbar">
                    <SensorTooling
                        key={formKey}
                        selectedSensors={selectedSensors}
                        sensorMetadata={sensorMetadata}
                        onConfigChange={handleConfigChange}
                        onRemoveSensor={handleSensorToggle}
                        onFormulaSubmit={handleFormulaSubmit}
                        onDescriptionChange={setDescription}
                        onUnitChange={setUnit}
                        onComponentChange={setComponent}
                        nameError={nameError}
                    />
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
                        availableSensors={liveSensors}
                        editingTag={editingTag}
                        onEdit={tag => { setEditError(null); setEditingTag(tag); }}
                        onSaveEdit={handleSaveEdit}
                        savingEdit={savingEdit}
                        editError={editError}
                    />
                </div>
            )}

            {/* Footer — matches the approved prototype's `.mf`: a left-aligned
                contextual hint (what's missing, or a plain "ready" message)
                plus the action buttons on the right, one row. */}
            <div className="special-sensor-footer">
                {activeTab === 'create' ? (
                    <>
                        <span
                            role={addError && footerIssue === addError ? 'alert' : undefined}
                            className={`special-sensor-footer-hint${footerIssue ? ' is-danger' : ''}`}
                        >
                            {footerIssue ?? 'Adds a computed sensor to this workspace.'}
                        </span>
                        <span className="special-sensor-spacer" />
                        <button onClick={handleClose} className="special-sensor-btn">Cancel</button>
                        <button
                            onClick={handleAdd}
                            disabled={!canAdd || adding || !!sessionLost}
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

            {/* Toast */}
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
    );
}
