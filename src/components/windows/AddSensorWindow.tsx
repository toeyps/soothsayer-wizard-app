import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { X, Plus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { subscribe } from "../../utils/tauriEvents";
import { FailureModel, FailureGroupStateChangedPayload, SensorMetadata, SensorOperationConfig, SpecialSensorRecipe } from "../../types";
import SensorExplorer from "./SensorExplorer";
import SensorTooling from "./SensorTooling";
import ManageSpecialSensors from "./ManageSpecialSensors";
import { debugLog } from "../../utils/debugLog";
import {
    buildSpecialSensorUsage, cycleConflicts, dependentsToRecompute,
    orderRecipesByDependency, reorderRecipesByTags,
} from "../../utils/specialSensorDeps";
import { recomputeSpecialSensors } from "../../utils/specialSensorRecompute";
import { renameTagInArray, renameTagInRecipes } from "../../utils/specialSensorRename";
import { nameProblem, sameTag } from "../../utils/specialSensorNaming";
import { mergeIntoPlot } from "../../utils/specialSensorPlot";

/** How long a deleted special sensor can still be brought back. Nothing has
 *  left this window yet during that time — see `commitDelete`. */
const UNDO_WINDOW_MS = 8000;

const tagKey = (tag: string) => tag.trim().toLowerCase();

/** What a rejected `invoke` carries, as text for the user. Tauri rejects with
 *  the command's `Err(String)` itself, not an `Error`. */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type ToastKind = 'ok' | 'error';

export default function AddSensorWindow() {
    const [sensors, setSensors] = useState<string[]>([]);
    const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
    // What the dashboard chart is currently plotting. Distinct from
    // `selectedSensors` above, which is this window's own picker (deliberately
    // left empty on open -- see the sensors-data handler).
    // A local MIRROR of that: seeded by `sensors-data`, then advanced by this
    // window's own adds/deletes/renames. It is only ever used for the Manage
    // tab's "on chart" badge -- the Dashboard owns the real selection (and
    // merges what this window adds into it), so this can lag a toggle the user
    // makes in the Dashboard afterwards without anything acting on it.
    const [plottedSensors, setPlottedSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [operationConfig, setOperationConfig] = useState<SensorOperationConfig | null>(null);
    const [description, setDescription] = useState('');
    const [unit, setUnit] = useState('');
    const [component, setComponent] = useState('');

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
    const [rejectedNames, setRejectedNames] = useState<string[]>([]);

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
    const [recipes, setRecipes] = useState<SpecialSensorRecipe[]>([]);
    // Workspace the last `sensors-data` belonged to — stamped on every emit.
    const workspaceIdRef = useRef<string | undefined>(undefined);
    const [models, setModels] = useState<FailureModel[]>([]);
    // Formula tag -> sensors it references, from Rust. Null until the lookup
    // answers; Manage refuses to delete anything while it is null, because an
    // empty map would look exactly like "nothing depends on anything".
    const [formulaRefs, setFormulaRefs] = useState<Map<string, string[]> | null>(null);

    // A deletion inside its undo window: already gone from the list here, not
    // yet told to the dashboard.
    const [pendingDelete, setPendingDelete] = useState<{ tags: string[]; label: string } | null>(null);
    const pendingDeleteRef = useRef<{ tags: string[]; label: string } | null>(null);
    const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Which row has its editor open, and how the last save attempt went.
    const [editingTag, setEditingTag] = useState<string | null>(null);
    const [savingEdit, setSavingEdit] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

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
                models?: FailureModel[]
            }>('sensors-data', (event) => {
                debugLog("Received sensors-data:", event.payload);
                // This window belongs to whichever workspace it was last
                // handed data for; every emit below is tagged with it so the
                // Dashboard can drop anything from a different project.
                workspaceIdRef.current = event.payload.workspaceId;
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
                setLoading(false);
            });

            unlistenData = off;
            // Registered before asking, so the reply can't be missed.
            await off.ready;

            // 2. Request data
            await emit('request-sensors');

            // 3. Fallback logic
            try {
                const allHeaders = await invoke<string[]>('get_all_sensors');
                if (allHeaders.length > 0) {
                    setSensors(prev => prev.length === 0 ? allHeaders.filter(h => h.trim().toLowerCase() !== 'timestamp') : prev);
                    setLoading(false);
                } else {
                    const paths = await invoke<string[]>('get_loaded_paths');
                    if (paths && paths.length > 0) {
                        await invoke("load_csv", { paths });
                        const retriedHeaders = await invoke<string[]>('get_all_sensors');
                        setSensors(prev => prev.length === 0 ? retriedHeaders.filter(h => h.trim().toLowerCase() !== 'timestamp') : prev);
                        setLoading(false);
                    }
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
        };
    }, []);

    // Keep `models` current. It arrives with `sensors-data` once, when the
    // window opens -- but this window can stay open while the user assigns a
    // special sensor to a model in Build Model, and delete-protection reads
    // `models`. A stale list would let a sensor a model now uses be deleted,
    // and since a delete drops the column for real, that model would be left
    // pointing at data that is gone. Same workspace-scoped broadcast
    // Dashboard and Build Model use; one without OUR workspace id is foreign.
    useEffect(() => {
        const off = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            const id = workspaceIdRef.current;
            if (!id || event.payload?.workspaceId !== id) return;
            if (Array.isArray(event.payload.models)) setModels(event.payload.models);
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

    /**
     * Actually delete: tell the dashboard (which drops the recipe, the
     * metadata, the chart line and the tag itself) and forget the sensor here
     * too, so it can no longer be picked as an input for a new one.
     */
    const commitDelete = useCallback(async (tags: string[]) => {
        if (tags.length === 0) return;
        const gone = (tag: string) => tags.some(t => sameTag(t, tag));
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
            await invoke<number>('remove_sensor_columns', { names: tags });
        } catch (err) {
            console.error('Failed to drop the deleted sensor column(s) from the session:', err);
            showToast(
                `Removed ${tags.join(', ')} from the workspace, but couldn't free its data (${errorText(err)}). `
                + 'Creating a sensor with the same name may fail until the app is restarted.',
                'error',
            );
        }
        try {
            await emit('delete-special-sensors', { tags, workspaceId: workspaceIdRef.current });
        } catch (err) {
            console.error('Failed to tell the dashboard about the deletion:', err);
        }
    }, [showToast]);

    /** Commit whatever is mid-undo right now (window closing, or a second
     *  delete starting). Safe to call when nothing is pending. */
    const flushPendingDelete = useCallback(async () => {
        const pending = pendingDeleteRef.current;
        if (!pending) return;
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        deleteTimer.current = null;
        pendingDeleteRef.current = null;
        setPendingDelete(null);
        await commitDelete(pending.tags);
    }, [commitDelete]);

    const handleDeleteSensor = useCallback(async (tag: string) => {
        await flushPendingDelete();
        const pending = { tags: [tag], label: tag };
        pendingDeleteRef.current = pending;
        setPendingDelete(pending);
        deleteTimer.current = setTimeout(() => {
            deleteTimer.current = null;
            pendingDeleteRef.current = null;
            setPendingDelete(null);
            void commitDelete(pending.tags);
        }, UNDO_WINDOW_MS);
    }, [commitDelete, flushPendingDelete]);

    const handleUndoDelete = useCallback(() => {
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        deleteTimer.current = null;
        pendingDeleteRef.current = null;
        setPendingDelete(null);
    }, []);

    /** Rows the Manage tab shows: a sensor inside its undo window is already
     *  gone from here, which is also what unlocks anything built on top of
     *  it for deletion in the same breath. */
    const manageRecipes = useMemo(() => {
        if (!pendingDelete) return recipes;
        return recipes.filter(r => !pendingDelete.tags.some(t => sameTag(t, r.tag)));
    }, [recipes, pendingDelete]);

    /** Every sensor tag still in play: `sensors` minus anything inside its undo
     *  window. A name freed by a pending delete is usable straight away -- the
     *  delete is settled (column dropped) before the new sensor is created. */
    const liveSensors = useMemo(() => {
        if (!pendingDelete) return sensors;
        return sensors.filter(s => !pendingDelete.tags.some(t => sameTag(t, s)));
    }, [sensors, pendingDelete]);

    /**
     * Save an edited special sensor -- including a rename (the Name field is
     * no longer locked; `renamedFrom` is set when it changed).
     *
     * Editing is not a local change. The sensor's column was computed once and
     * lives in the Rust session; changing the recipe means recomputing it, and
     * anything built on top of it was computed from the OLD values and is
     * stale the moment this lands. So the edit recomputes the sensor and then
     * replays every downstream recipe, in recipe order.
     *
     * A rename adds steps around that replay. Before it, every OTHER recipe
     * that still names the OLD tag -- a formula's `$oldName` reference, or an
     * operation's `sourceSensors` entry -- has to be rewritten to the new one
     * (`renameTagInRecipes`, via the Rust `rename_formula_refs` command), or
     * replaying them would ask the backend to resolve a name that no longer
     * means anything. The dependency graph itself
     * (`usage`/`cycleConflicts`/`dependentsToRecompute`) is still keyed by the
     * OLD tag at this point -- `manageRecipes` hasn't been touched yet -- so
     * every lookup into it uses `identityTag`, not `next.recipe.tag`.
     *
     * After it, the OLD column has to go: the recompute writes the sensor
     * under its NEW name only, and the old column would otherwise sit in the
     * session forever -- still holding the old values, and still blocking a new
     * sensor from ever being called by the old name. That removal is the LAST
     * step, after the new column exists, every downstream recipe has been
     * replayed against it, and the Dashboard has been told -- so a failure
     * anywhere earlier can never leave a recipe pointing at a column that is
     * gone. (Skipped when the name only changed case: Rust overwrites that
     * very column in place, and removing "the old one" would delete the new.)
     *
     * Three things get refused rather than repaired afterwards: a formula that
     * references nothing (there would be no column to compute), one that makes
     * the sensor depend on itself — directly or through the chain — and a
     * rename that collides with another sensor's tag. Nothing later in the
     * app would catch a cycle: the recipes would just replay in order on the
     * next workspace open, each reading whatever stale column happened to be
     * there.
     *
     * The recipe LIST's order is kept a valid build order too (see
     * `orderRecipesByDependency`): the workspace-reopen replay runs it top to
     * bottom, and an edit can point an early sensor at a later one.
     */
    const handleSaveEdit = useCallback(async (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string }) => {
        setSavingEdit(true);
        setEditError(null);
        // Only true while the recompute is in flight: if IT fails part-way, the
        // renamed sensor's new column may already exist and nothing points at
        // it, so it is cleaned up below. Never set once the recompute is done.
        let recomputeInFlight = false;
        const oldTag = next.renamedFrom;
        const newTag = next.recipe.tag;
        const removesOldColumn = !!oldTag && !sameTag(oldTag, newTag);
        try {
            // Any deletion still mid-undo is settled first, so the dependency
            // graph this reasons about matches what the dashboard holds.
            await flushPendingDelete();

            if (oldTag) {
                if (!newTag.trim()) throw new Error('Name is required.');
                const problem = nameProblem(newTag, []);
                if (problem) throw new Error(problem);
                const collides = liveSensors.some(s => sameTag(s, newTag) && !sameTag(s, oldTag));
                if (collides) throw new Error(`"${newTag}" is already in use by another sensor.`);
            }

            // Without the formula-reference lookup the window can't tell what is
            // built on this sensor -- so it could neither recompute nor (for a
            // rename) rewrite those dependents, and would then drop the old
            // column from under them. Refuse until it has answered.
            if (formulaRefs === null && recipes.some(r => r.kind === 'formula')) {
                throw new Error('Still working out which sensors are built on this one. Try again in a moment.');
            }

            let nextInputs: string[];
            if (next.recipe.kind === 'formula') {
                const refs = await invoke<string[][]>('extract_formula_refs', { formulas: [next.recipe.formula] });
                nextInputs = refs[0] ?? [];
                if (nextInputs.length === 0) {
                    throw new Error('This formula doesn\'t reference any sensor. Use $Name, or ${Name With Spaces}.');
                }
            } else {
                nextInputs = next.recipe.sourceSensors;
            }

            // The identity this recipe is still known by across `manageRecipes`
            // / `formulaRefs` / `models` -- the OLD tag when renaming, since
            // none of those have caught up to the new one yet.
            const identityTag = oldTag ?? next.recipe.tag;

            const usage = buildSpecialSensorUsage({
                recipes: manageRecipes,
                formulaRefs: formulaRefs ?? new Map(),
                models,
                selectedSensors: plottedSensors,
            });

            const conflicts = cycleConflicts(manageRecipes, usage, identityTag, nextInputs);
            if (conflicts.length > 0) {
                throw new Error(
                    `"${next.recipe.tag}" can't be built from ${conflicts.join(', ')} — that would make it depend on itself.`,
                );
            }

            const downstream = dependentsToRecompute(manageRecipes, usage, identityTag);

            // Carry the rename into every downstream recipe's own stored
            // formula/sourceSensors BEFORE any of them replay, so each one
            // resolves against the sensor's new name from here on.
            const renamedDownstream = oldTag
                ? await renameTagInRecipes(downstream, oldTag, newTag, (cmd, args) => invoke(cmd, args))
                : downstream;

            // New column first (replace: true creates it when nothing matches
            // the new name), then everything built on it, against that name.
            recomputeInFlight = true;
            await recomputeSpecialSensors([next.recipe, ...renamedDownstream], (cmd, args) => invoke(cmd, args));
            recomputeInFlight = false;

            const applyEdit = (list: SpecialSensorRecipe[]) => list.map(r => {
                if (sameTag(r.tag, identityTag)) return next.recipe;
                const rewritten = renamedDownstream.find(d => sameTag(d.tag, r.tag));
                return rewritten ?? r;
            });

            // What each recipe reads, after this edit, for ordering. Formula
            // inputs for untouched recipes come from the lookup this window
            // already holds; a rename has to be carried into them by hand.
            const inputsOf = (r: SpecialSensorRecipe): string[] => {
                if (sameTag(r.tag, newTag)) return nextInputs;
                if (r.kind === 'operation') return r.sourceSensors ?? [];
                const refs = formulaRefs?.get(tagKey(r.tag)) ?? [];
                return oldTag ? refs.map(x => (sameTag(x, oldTag) ? newTag : x)) : refs;
            };
            const edited = applyEdit(manageRecipes);
            const ordered = orderRecipesByDependency(edited, inputsOf);
            const orderChanged = ordered.some((r, i) => edited[i] !== r);
            const recipeOrder = orderChanged ? ordered.map(r => r.tag) : undefined;

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
            }

            if (oldTag) {
                await emit('rename-special-sensor', {
                    oldTag,
                    newTag,
                    recipe: next.recipe,
                    metadata: next.metadata,
                    updatedRecipes: renamedDownstream,
                    recipeOrder,
                    workspaceId: workspaceIdRef.current,
                });
            } else {
                await emit('update-special-sensor', {
                    recipe: next.recipe,
                    metadata: next.metadata,
                    recomputed: [next.recipe.tag, ...downstream.map(r => r.tag)],
                    recipeOrder,
                    workspaceId: workspaceIdRef.current,
                });
            }

            // LAST: everything above succeeded and the Dashboard now knows the
            // new name, so nothing refers to the old column any more. A failure
            // here is not a failed rename -- it only leaves an orphan column
            // behind -- so it is reported, not thrown.
            let cleanupWarning: string | null = null;
            if (removesOldColumn && oldTag) {
                try {
                    await invoke<number>('remove_sensor_columns', { names: [oldTag] });
                } catch (err) {
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
            if (recomputeInFlight && removesOldColumn) {
                // The recompute died part-way through a rename: the new column
                // may exist but no recipe points at it (the Dashboard was never
                // told), and it would block creating a sensor by that name.
                // Best effort -- the original sensor was never touched.
                try { await invoke<number>('remove_sensor_columns', { names: [newTag] }); } catch { /* nothing more to do */ }
            }
            setEditError(errorText(err));
        } finally {
            setSavingEdit(false);
        }
    }, [flushPendingDelete, manageRecipes, recipes, formulaRefs, models, plottedSensors, liveSensors, showToast]);

    const handleClose = async () => {
        // A pending delete has not left this window yet; closing is the user
        // saying they meant it, so make it real before the window goes.
        await flushPendingDelete();
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

    /**
     * Run whatever calculation is currently configured (formula, legacy
     * config, or none -- "add as-is") and return what the Dashboard should
     * plot, the master-data metadata (description/unit/component) for the newly
     * created sensor -- the same fields a mapping CSV row supplies for an
     * imported sensor -- and its recipe.
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
    const computeCurrentRound = async (): Promise<{ plotSensors: string[]; newMetadata: SensorMetadata[]; newRecipes: SpecialSensorRecipe[] }> => {
        if (formulaMode && formulaExpression.trim()) {
            const newSensorName = await invoke<string>('evaluate_formula', {
                formula: formulaExpression,
                customName: formulaCustomName.trim() || null,
            });
            return {
                plotSensors: [newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: description.trim() || formulaCustomName.trim(),
                    unit: unit.trim(),
                    component: component.trim() || 'Uncategorized',
                }],
                newRecipes: [{ kind: 'formula', tag: newSensorName, formula: formulaExpression }],
            };
        }
        if (operationConfig) {
            const newSensorName = await invoke<string>('calculate_new_sensor', {
                sensors: selectedSensors,
                config: operationConfig,
            });
            return {
                plotSensors: [newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: description.trim() || (operationConfig.customName ?? '').trim(),
                    unit: unit.trim(),
                    component: component.trim() || 'Uncategorized',
                }],
                newRecipes: [{ kind: 'operation', tag: newSensorName, sourceSensors: selectedSensors, operationConfig }],
            };
        }
        return { plotSensors: selectedSensors, newMetadata: [], newRecipes: [] };
    };

    // Creates the sensor currently configured, tells Dashboard about it right
    // away (so the chart updates immediately), clears the form for the next
    // one, and keeps the window open -- there's no separate "finish" step;
    // "Close" just closes once the user is done adding sensors.
    const handleAdd = async () => {
        // The button is disabled in these states, so this only matters for a
        // second click that lands before React has re-rendered it disabled --
        // which would otherwise create twice (or hit the new duplicate-name
        // error on a sensor that was in fact created fine).
        if (addingRef.current || !canAdd) return;
        addingRef.current = true;
        setAdding(true);
        setAddError(null);
        const attemptedName = currentName.trim();
        try {
            // A name that is only taken by a sensor still inside its undo
            // window: settle that delete first (drops its column) or the
            // backend would refuse the name as "already exists".
            if (attemptedName && pendingDeleteRef.current?.tags.some(t => sameTag(t, attemptedName))) {
                await flushPendingDelete();
            }

            const { plotSensors, newMetadata, newRecipes } = await computeCurrentRound();
            setPlottedSensors(prev => mergeIntoPlot(prev, plotSensors).next);

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
            // plot -- see `AddSensorSelectionPayload`.
            await emit('add-sensor-selection', {
                sensors: plotSensors,
                operation: null,
                newMetadata,
                newRecipes,
                workspaceId: workspaceIdRef.current,
            });

            showToast(createdName ? `Added: ${newMetadata[0].description || createdName}` : `Added ${plotSensors.length} sensor(s)`);

            // Reset the picker for the next round.
            setSelectedSensors([]);
            setOperationConfig(null);
            setFormulaMode(false);
            setFormulaExpression('');
            setFormulaCustomName('');
            setDescription('');
            setUnit('');
            setComponent('');
        } catch (err) {
            console.error("Failed to add sensor:", err);
            const message = errorText(err);
            // The window didn't know of this name but the backend does (a
            // race, or a column this window was never told about): remember it
            // so the Name field flags it instead of letting the same click fail
            // again.
            if (attemptedName && /already exists/i.test(message)) {
                setRejectedNames(prev => (prev.some(n => sameTag(n, attemptedName)) ? prev : [...prev, attemptedName]));
            }
            setAddError(message);
        } finally {
            addingRef.current = false;
            setAdding(false);
        }
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
        if (!searchTerm) return sensors;
        const lowerTerm = searchTerm.toLowerCase();
        return sensors.filter(s => {
            const meta = sensorMetadata?.find(m => m.tag === s);
            const searchStr = meta
                ? `${s} ${meta.description} ${meta.component} ${meta.unit}`.toLowerCase()
                : s.toLowerCase();
            return searchStr.includes(lowerTerm);
        });
    }, [sensors, searchTerm, sensorMetadata]);


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
                </div>
                <button
                    onClick={handleClose}
                    className="scatter-regl-btn scatter-regl-btn-icon"
                    title="Close"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Main content — fixed 320px left column (Explorer) + flexible
                right column (Tooling), matching the approved prototype's own
                `.fv` grid. Kept mounted while the Manage tab is showing (just
                hidden via `display`), same as before. */}
            <div className="special-sensor-body" style={{ display: activeTab === 'create' ? 'grid' : 'none' }}>
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
                            disabled={!canAdd || adding}
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
