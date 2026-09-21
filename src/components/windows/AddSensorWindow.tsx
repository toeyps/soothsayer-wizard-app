import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Split from 'split.js';
import { X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { subscribe } from "../../utils/tauriEvents";
import { FailureModel, SensorMetadata, SensorOperationConfig, SpecialSensorRecipe } from "../../types";
import SensorExplorer from "./SensorExplorer";
import SensorTooling from "./SensorTooling";
import ManageSpecialSensors from "./ManageSpecialSensors";
import { debugLog } from "../../utils/debugLog";
import { buildSpecialSensorUsage, cycleConflicts, dependentsToRecompute } from "../../utils/specialSensorDeps";
import { recomputeSpecialSensors } from "../../utils/specialSensorRecompute";
import { renameTagInArray, renameTagInRecipes } from "../../utils/specialSensorRename";

/** How long a deleted special sensor can still be brought back. Nothing has
 *  left this window yet during that time — see `commitDelete`. */
const UNDO_WINDOW_MS = 8000;

/** Tag comparison is case-insensitive everywhere else the app matches sensor
 *  tags (Dashboard's own `byTag` maps, `specialSensorDeps`), so it is here. */
const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export default function AddSensorWindow() {
    const [sensors, setSensors] = useState<string[]>([]);
    const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
    // What the dashboard chart is currently plotting. Distinct from
    // `selectedSensors` above, which is this window's own picker (deliberately
    // left empty on open -- see the sensors-data handler).
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

    // Every click of "Add sensor" creates immediately and keeps the window
    // open (see handleAdd) rather than closing after exactly one -- so this
    // accumulates everything created so far this session, since Dashboard's
    // `add-sensor-selection` handler replaces its whole plotted selection on
    // each event rather than appending to it.
    const [pendingSensors, setPendingSensors] = useState<string[]>([]);

    const [toast, setToast] = useState<string | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        // Initialize Split.js
        const splitInstance = Split(['#split-0', '#split-1'], {
            sizes: [60, 40],
            minSize: [300, 150],
            gutterSize: 5,
            cursor: 'col-resize',
            direction: 'horizontal',
        });

        return () => {
            splitInstance.destroy();
        };
    }, []);

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
        // pendingSensors is what the next 'add-sensor-selection' emit replays
        // as the dashboard's whole plotted selection -- leaving a deleted tag
        // in it would put the sensor straight back on the chart.
        setPendingSensors(prev => prev.filter(t => !gone(t)));
        try {
            await emit('delete-special-sensors', { tags, workspaceId: workspaceIdRef.current });
        } catch (err) {
            console.error('Failed to tell the dashboard about the deletion:', err);
        }
    }, []);

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
     * A rename adds one more step before that replay: every OTHER recipe that
     * still names the OLD tag -- a formula's `$oldName` reference, or an
     * operation's `sourceSensors` entry -- has to be rewritten to the new one
     * FIRST (`renameTagInRecipes`, via the Rust `rename_formula_refs`
     * command), or replaying them next would ask the backend to resolve a
     * name that no longer means anything (the renamed sensor's own recompute
     * below creates its column under the NEW name only). The dependency graph
     * itself (`usage`/`cycleConflicts`/`dependentsToRecompute`) is still keyed
     * by the OLD tag at this point -- `manageRecipes` hasn't been touched yet
     * -- so every lookup into it uses `identityTag`, not `next.recipe.tag`.
     *
     * Three things get refused rather than repaired afterwards: a formula that
     * references nothing (there would be no column to compute), one that makes
     * the sensor depend on itself — directly or through the chain — and (new)
     * a rename that collides with another sensor's tag. Nothing later in the
     * app would catch a cycle: the recipes would just replay in order on the
     * next workspace open, each reading whatever stale column happened to be
     * there.
     */
    const handleSaveEdit = useCallback(async (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string }) => {
        setSavingEdit(true);
        setEditError(null);
        try {
            // Any deletion still mid-undo is settled first, so the dependency
            // graph this reasons about matches what the dashboard holds.
            await flushPendingDelete();

            const oldTag = next.renamedFrom;
            const newTag = next.recipe.tag;

            if (oldTag) {
                if (!newTag.trim()) throw new Error('Name is required.');
                const collides = sensors.some(s => sameTag(s, newTag) && !sameTag(s, oldTag));
                if (collides) throw new Error(`"${newTag}" is already in use by another sensor.`);
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

            await recomputeSpecialSensors([next.recipe, ...renamedDownstream], (cmd, args) => invoke(cmd, args));

            setRecipes(prev => prev.map(r => {
                if (sameTag(r.tag, identityTag)) return next.recipe;
                const rewritten = renamedDownstream.find(d => sameTag(d.tag, r.tag));
                return rewritten ?? r;
            }));
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
                setPendingSensors(prev => renameTagInArray(prev, oldTag, newTag));
            }

            if (oldTag) {
                await emit('rename-special-sensor', {
                    oldTag,
                    newTag,
                    recipe: next.recipe,
                    metadata: next.metadata,
                    updatedRecipes: renamedDownstream,
                    workspaceId: workspaceIdRef.current,
                });
            } else {
                await emit('update-special-sensor', {
                    recipe: next.recipe,
                    metadata: next.metadata,
                    recomputed: [next.recipe.tag, ...downstream.map(r => r.tag)],
                    workspaceId: workspaceIdRef.current,
                });
            }

            setEditingTag(null);
            showToast(
                oldTag
                    ? `Renamed "${oldTag}" to "${newTag}"${downstream.length > 0 ? ` — updated ${downstream.length} sensor(s) built on it` : ''}`
                    : downstream.length > 0
                        ? `Updated ${next.recipe.tag} — recomputed ${downstream.length} sensor(s) built on it`
                        : `Updated ${next.recipe.tag}`,
            );
        } catch (err) {
            setEditError(err instanceof Error ? err.message : String(err));
        } finally {
            setSavingEdit(false);
        }
        // `showToast` is a stable-enough local helper defined above; it reads
        // only refs and setters.
    }, [flushPendingDelete, manageRecipes, formulaRefs, models, plottedSensors, sensors]);

    const handleClose = async () => {
        // A pending delete has not left this window yet; closing is the user
        // saying they meant it, so make it real before the window goes.
        await flushPendingDelete();
        await getCurrentWindow().close();
    };

    const showToast = (message: string) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(message);
        toastTimer.current = setTimeout(() => setToast(null), 2200);
    };

    // Whether the current selection/operation would actually create a new
    // derived sensor (needs a name) vs. just adding the raw sensor(s)
    // through as-is (nothing to name). Mirrors SensorTooling's own
    // `creatingSomething`, computed here from the same config/formula state
    // it reports up via onConfigChange/onFormulaSubmit.
    const isCreatingSomething = (formulaMode && formulaExpression.trim() !== '') || operationConfig !== null;
    const currentName = formulaMode ? formulaCustomName : (operationConfig?.customName ?? '');

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
    const canAdd = missingCreateFields.length === 0;

    /**
     * Run whatever calculation is currently configured (formula, legacy
     * config, or none -- "add as-is") and return the resulting sensor list,
     * the master-data metadata (description/unit/component) for the newly
     * created sensor -- the same fields a mapping CSV row supplies for an
     * imported sensor -- and its recipe.
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
    const computeCurrentRound = async (): Promise<{ sensorsForEmit: string[]; newMetadata: SensorMetadata[]; newRecipes: SpecialSensorRecipe[] }> => {
        if (formulaMode && formulaExpression.trim()) {
            const newSensorName = await invoke<string>('evaluate_formula', {
                formula: formulaExpression,
                customName: formulaCustomName.trim() || null,
            });
            return {
                sensorsForEmit: [...selectedSensors, newSensorName],
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
                sensorsForEmit: [...selectedSensors, newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: description.trim() || (operationConfig.customName ?? '').trim(),
                    unit: unit.trim(),
                    component: component.trim() || 'Uncategorized',
                }],
                newRecipes: [{ kind: 'operation', tag: newSensorName, sourceSensors: selectedSensors, operationConfig }],
            };
        }
        return { sensorsForEmit: selectedSensors, newMetadata: [], newRecipes: [] };
    };

    // Creates the sensor currently configured, tells Dashboard about it right
    // away (so the chart updates immediately), clears the form for the next
    // one, and keeps the window open -- there's no separate "finish" step;
    // "Close" just closes once the user is done adding sensors.
    const handleAdd = async () => {
        // Defensive -- the button itself is disabled in this state, so this
        // only matters if it's ever reached some other way.
        if (!canAdd) return;
        setLoading(true);
        try {
            const { sensorsForEmit, newMetadata, newRecipes } = await computeCurrentRound();
            const nextPending = Array.from(new Set([...pendingSensors, ...sensorsForEmit]));
            setPendingSensors(nextPending);

            const createdName = newMetadata[0]?.tag;
            if (createdName) {
                // Make the new sensor pickable as an input for the next round
                // (e.g. building a second sensor on top of the first).
                setSensors(prev => (prev.includes(createdName) ? prev : [...prev, createdName]));
                setSensorMetadata(prev => {
                    const existing = prev ?? [];
                    return existing.some(m => m.tag === createdName) ? existing : [...existing, newMetadata[0]];
                });
                // Show up on the Manage tab right away, without waiting for
                // the dashboard to send a fresh sensors-data.
                setRecipes(prev => {
                    const others = prev.filter(r => !newRecipes.some(n => sameTag(n.tag, r.tag)));
                    return [...others, ...newRecipes];
                });
            }

            await emit('add-sensor-selection', {
                sensors: nextPending,
                operation: null,
                newMetadata,
                newRecipes,
                workspaceId: workspaceIdRef.current,
            });

            showToast(createdName ? `Added: ${newMetadata[0].description || createdName}` : `Added ${sensorsForEmit.length} sensor(s)`);

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
            alert("Failed: " + String(err));
        } finally {
            setLoading(false);
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
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Special Sensors</h2>
                <button
                    onClick={handleClose}
                    className="scatter-regl-btn scatter-regl-btn-icon"
                    title="Close"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Tabs — creating and managing are the same window because the
                two are the same job: you build a sensor, then you want to see
                what you built and get rid of what you no longer use. */}
            <div className="flex shrink-0 gap-1 px-4 pt-2" style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }} role="tablist">
                {(['create', 'manage'] as const).map(tab => (
                    <button
                        key={tab}
                        role="tab"
                        aria-selected={activeTab === tab}
                        onClick={() => setActiveTab(tab)}
                        className="px-3 py-1.5 rounded-t"
                        style={{
                            fontSize: '12px',
                            fontWeight: activeTab === tab ? 600 : 500,
                            color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
                            backgroundColor: activeTab === tab ? 'var(--card-bg)' : 'transparent',
                            borderBottom: `2px solid ${activeTab === tab ? 'var(--accent-color)' : 'transparent'}`,
                        }}
                    >
                        {tab === 'create' ? 'Create' : `Manage${recipes.length > 0 ? ` (${recipes.length})` : ''}`}
                    </button>
                ))}
            </div>

            {/* Main Content (Split.js).
                Kept mounted while the Manage tab is showing: Split.js binds to
                #split-0/#split-1 once on mount, and unmounting them would
                leave it pointing at elements that no longer exist. */}
            <div className="flex-1 min-h-0 overflow-hidden" style={{ display: activeTab === 'create' ? 'flex' : 'none' }}>
                {/* Left: Explorer */}
                <div id="split-0" className="flex flex-col h-full min-h-0 divide-y" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex-1 min-h-0 overflow-hidden">
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
                </div>

                {/* Right: Tooling */}
                <div id="split-1" className="flex flex-col h-full overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="px-4 py-2 text-xs font-bold tracking-wider uppercase border-b" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                        Tooling
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <SensorTooling
                            selectedSensors={selectedSensors}
                            sensorMetadata={sensorMetadata}
                            onConfigChange={handleConfigChange}
                            onRemoveSensor={handleSensorToggle}
                            onFormulaSubmit={handleFormulaSubmit}
                            onDescriptionChange={setDescription}
                            onUnitChange={setUnit}
                            onComponentChange={setComponent}
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
                        selectedSensors={plottedSensors}
                        formulaRefs={formulaRefs}
                        onDelete={handleDeleteSensor}
                        pendingDelete={pendingDelete}
                        onUndo={handleUndoDelete}
                        availableSensors={sensors}
                        editingTag={editingTag}
                        onEdit={tag => { setEditError(null); setEditingTag(tag); }}
                        onSaveEdit={handleSaveEdit}
                        savingEdit={savingEdit}
                        editError={editError}
                    />
                </div>
            )}

            {/* Footer */}
            <div className="flex flex-col gap-2 px-4 py-3 border-t shrink-0" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                {activeTab === 'create' && missingCreateFields.length > 0 && (
                    <p className="text-xs" style={{ color: 'var(--danger)' }}>
                        Fill in {missingCreateFields.join(', ')} before adding.
                    </p>
                )}
                <div className="flex justify-end gap-2">
                    <button onClick={handleClose} className="px-4 py-1.5 rounded text-sm" style={{ backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Close</button>
                    {activeTab === 'create' && (
                        <button
                            onClick={handleAdd}
                            disabled={!canAdd}
                            title={canAdd ? undefined : `Fill in ${missingCreateFields.join(', ')} first`}
                            className="px-4 py-1.5 rounded text-white text-sm font-medium"
                            style={{ backgroundColor: 'var(--accent-color)', opacity: canAdd ? 1 : 0.45, cursor: canAdd ? 'pointer' : 'not-allowed' }}
                        >
                            Add sensor
                        </button>
                    )}
                </div>
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
                        backgroundColor: 'var(--card-bg)',
                        border: '1px solid var(--ok)',
                        color: 'var(--ok)',
                    }}
                >
                    ✓ {toast}
                </div>
            )}
        </div>
    );
}
