import { useEffect, useMemo, useRef, useState } from "react";
import { Star, X } from "lucide-react";
import {
    SensorMetadata,
    SpecialSensorRecipe,
} from "../../types";
import { useCalculationEngine, CalculationEngineSeed } from "../../hooks/useCalculationEngine";
import { ButtonBuilder, BASE_OP_IDS, ComponentSelect } from "./SensorTooling";
import { nameProblem } from "../../utils/specialSensorNaming";
import { describeRecipe } from "../../utils/specialSensorDescribe";

/**
 * Edit one special sensor in place.
 *
 * The sensor's name (`tag`) can be changed here too — it is what other
 * formulas reference (`$name`), what Failure Group models store, and what
 * the chart, colours and axis ranges are keyed by, so a rename has to carry
 * through all of that at once. This component only collects the new name and
 * flags that a rename happened (`renamedFrom` on `onSave`); the actual
 * cascade — rewriting every other recipe that names this sensor, every
 * dashboard state slice keyed by the tag, every Failure Group model field —
 * is the caller's job (`AddSensorWindow.handleSaveEdit`), same as every other
 * "is this actually allowed" decision below.
 *
 * This component only collects values. Whether the edit is actually allowed —
 * does the formula parse, does it create a cycle, does the new name collide
 * with an existing one — is decided by the caller, which has the backend and
 * the dependency graph; it reports back through `error`.
 *
 * Edit lock (2026-10-03): when `lockMessage` is set -- a model, the Running
 * condition, or a sensor built on this one that one of them uses -- the name,
 * formula and sources are shown read-only under a banner saying who uses it,
 * and Save sends the STORED recipe back unchanged with only the description /
 * unit / component the user edited. The caller still re-checks the lock inside
 * its queue; this is the friendly half, not the enforcement.
 *
 * An operation-kind recipe (`sum(...)`, `a + 10`, ...) is edited with the
 * SAME single-sensor-vs-combine button UI Create uses (`ButtonBuilder`),
 * driven by a `useCalculationEngine` instance seeded from the existing
 * config — not a separate, narrower dropdown. That UI switches shape as
 * source sensors are added or removed, exactly like Create does, and can
 * resolve to either an operation config OR a formula (picking a
 * formula-backed shortcut, or leaving the "Combine with operators" chain
 * active, upgrades the saved recipe from `operation` to `formula` kind --
 * the same thing that happens creating one from scratch). A formula-kind
 * recipe is still edited as raw text: that's already strictly more
 * expressive than anything the button UI could represent, and is exactly
 * the "Edit as text instead" escape hatch Create itself offers.
 */

interface Props {
    recipe: SpecialSensorRecipe;
    /** Full sensor metadata list — not just this recipe's own entry. Needed
     *  to show SOURCE sensors by their description (`getSensorName`, same
     *  as Create), not just this sensor's own name/unit/component fields. */
    sensorMetadata: SensorMetadata[] | null;
    /** Every tag that can be used as an input to an operation recipe. */
    availableSensors: string[];
    onCancel: () => void;
    /** `renamedFrom` is set (to the recipe's ORIGINAL tag) exactly when the
     *  Name field was changed — the caller uses its presence, not a string
     *  comparison, to decide whether the rename cascade needs to run. */
    onSave: (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string }) => void;
    /** True while the caller is recomputing — the form stays visible but frozen. */
    saving: boolean;
    /** Why the last save attempt was refused, in the user's words. */
    error: string | null;
    /** Set while the sensor is locked (see the edit-lock note above): the
     *  plain-language reason, shown in a banner. */
    lockMessage?: string | null;
}

const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '5px 8px',
    fontSize: '12px',
    borderRadius: 5,
    backgroundColor: 'var(--input-bg)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
};

const labelStyle: React.CSSProperties = {
    fontSize: '10.5px',
    letterSpacing: '.05em',
    textTransform: 'uppercase',
    color: 'var(--text-faint)',
    marginBottom: 3,
    display: 'block',
};

/** Seed a fresh `useCalculationEngine` from an existing operation-kind
 *  recipe, so its button UI opens showing what's actually configured
 *  instead of a blank form. `undefined` for a formula-kind recipe (that
 *  branch never mounts the engine at all — see the component below). */
function seedFromRecipe(recipe: SpecialSensorRecipe): CalculationEngineSeed | undefined {
    if (recipe.kind !== 'operation') return undefined;
    const config = recipe.operationConfig;
    if (config.mode === 'single' && config.singleOp) {
        return { operationId: config.singleOp.type, value: config.singleOp.value };
    }
    if (config.mode === 'multi' && config.multiOp) {
        return { operationId: config.multiOp.type };
    }
    return undefined;
}

export default function SpecialSensorEditor({
    recipe, sensorMetadata, availableSensors, onCancel, onSave, saving, error, lockMessage,
}: Props) {
    const locked = !!lockMessage;
    const meta = sensorMetadata?.find(m => m.tag.toLowerCase() === recipe.tag.toLowerCase());
    const [description, setDescription] = useState(meta?.description ?? '');
    const [unit, setUnit] = useState(meta?.unit ?? '');
    const [component, setComponent] = useState(meta?.component ?? '');
    const existingComponents = Array.from(
        new Set((sensorMetadata ?? []).map(m => m.component).filter((c): c is string => !!c)),
    ).sort();

    // ---- Name (rename support) ---------------------------------------------
    const [tag, setTag] = useState(recipe.tag);
    const trimmedTag = tag.trim();
    const tagChanged = !locked && trimmedTag !== recipe.tag;
    const tagError = locked ? null : !trimmedTag
        ? 'Name is required'
        : tagChanged && availableSensors.some(
            s => s.toLowerCase() !== recipe.tag.toLowerCase() && s.toLowerCase() === trimmedTag.toLowerCase(),
        )
            ? `"${trimmedTag}" is already in use by another sensor`
            // `}` / reserved time-column names: the collision list is passed
            // empty because the check above already owns "in use".
            : tagChanged ? nameProblem(trimmedTag, []) : null;

    const isFormula = recipe.kind === 'formula';

    // ---- Formula-kind editing: unchanged, raw text -------------------------
    const [formula, setFormula] = useState(recipe.kind === 'formula' ? recipe.formula : '');

    // ---- Operation-kind editing: the same engine + button UI as Create -----
    const [sources, setSources] = useState<string[]>(recipe.kind === 'operation' ? recipe.sourceSensors : []);
    const [openChainDropdown, setOpenChainDropdown] = useState<number | null>(null);
    // Seeded once at mount from the recipe as it was when this row's editor
    // opened -- safe because `ManageSpecialSensors` remounts this component
    // (via `key={recipe.tag}`) whenever which sensor is being edited changes,
    // so "once at mount" always means "once per edit session", never stale.
    const engine = useCalculationEngine(sources, useMemo(() => seedFromRecipe(recipe), [])); // eslint-disable-line react-hooks/exhaustive-deps

    // Same reset `SensorTooling` itself does when its `selectedSensors` prop
    // changes -- and for the same reason: an operation/shortcut picked for
    // one set of source sensors doesn't mean anything for a different set
    // (e.g. a "starting value" that's no longer even selected). This isn't
    // inside `useCalculationEngine` itself, so reusing the engine here
    // doesn't get it for free; it has to be replicated on this side of the
    // seam too. Guarded to skip the very first render so the seeded
    // operation survives mounting the editor.
    const prevSourcesKey = useRef(sources.join("|"));
    useEffect(() => {
        const key = sources.join("|");
        if (key !== prevSourcesKey.current) {
            prevSourcesKey.current = key;
            engine.setOperationId(null);
            engine.setWrapFunc(null);
        }
    }, [sources, engine.setOperationId, engine.setWrapFunc]);

    const getSensorName = (tag: string) => {
        const m = sensorMetadata?.find(s => s.tag === tag);
        return m ? m.description || tag : tag;
    };

    const pickingBase = engine.opGroup === "multi" && BASE_OP_IDS.includes(engine.operationId ?? "");

    const addable = useMemo(
        () => availableSensors.filter(
            s => s.toLowerCase() !== recipe.tag.toLowerCase()
                && s.toLowerCase() !== trimmedTag.toLowerCase()
                && !sources.some(picked => picked.toLowerCase() === s.toLowerCase()),
        ),
        [availableSensors, sources, recipe.tag, trimmedTag],
    );

    // Same fix as `SensorTooling`'s own `buildResult`: `engine.build` is a
    // properly-deps'd `useCallback`, but calling it returns a fresh object
    // every time, so this has to be memoized on the call itself or every
    // unrelated re-render would look like the calculation just changed.
    const buildResult = useMemo(() => engine.build(), [engine.build]);

    // Name + Description + Unit + Component are all required before saving
    // is allowed — mirrors the same rule Create enforces (see
    // AddSensorWindow's `missingCreateFields`), so a sensor can't leave this
    // form half-described either.
    const missingFields = [
        !locked && !trimmedTag && 'a name',
        !description.trim() && 'a description',
        !unit.trim() && 'a unit',
        !component.trim() && 'a component',
    ].filter((f): f is string => !!f);

    const canSave =
        !saving && !tagError && missingFields.length === 0
        && (locked || (isFormula ? formula.trim().length > 0 : buildResult.kind !== 'none'));

    const submit = () => {
        if (locked) {
            // Only the descriptive fields can change: hand the stored recipe
            // back as it is, under its own name.
            onSave({
                recipe,
                metadata: {
                    ...(meta ?? { tag: recipe.tag, description: '', unit: '', component: '' }),
                    tag: recipe.tag,
                    description: description.trim(),
                    unit: unit.trim(),
                    component: component.trim() || 'Uncategorized',
                },
            });
            return;
        }
        const nextMetadata: SensorMetadata = {
            ...(meta ?? { tag: trimmedTag, description: '', unit: '', component: '' }),
            tag: trimmedTag,
            description: description.trim(),
            unit: unit.trim(),
            component: component.trim() || 'Uncategorized',
        };

        let nextRecipe: SpecialSensorRecipe;
        if (isFormula) {
            nextRecipe = { kind: 'formula', tag: trimmedTag, formula: formula.trim() };
        } else if (buildResult.kind === 'legacy') {
            nextRecipe = {
                kind: 'operation',
                tag: trimmedTag,
                sourceSensors: sources,
                // The name is forced back so a recomputation can never rename
                // the column out from under everything pointing at it.
                operationConfig: { ...buildResult.config, customName: trimmedTag },
            };
        } else if (buildResult.kind === 'formula') {
            // Picking a formula-backed shortcut (or leaving the operator
            // chain active) resolves to a formula, not an operation config --
            // the saved recipe's kind follows that, exactly like creating a
            // new sensor this way would.
            nextRecipe = { kind: 'formula', tag: trimmedTag, formula: buildResult.expression };
        } else {
            return; // canSave already guards this; nothing to submit.
        }
        onSave({
            recipe: nextRecipe,
            metadata: nextMetadata,
            renamedFrom: tagChanged ? recipe.tag : undefined,
        });
    };

    return (
        <div className="px-3 pb-3 pt-0.5">
            <div
                className="rounded px-3 py-3 flex flex-col gap-3"
                style={{ backgroundColor: 'var(--surface-hi)', border: '1px solid var(--border)' }}
            >
                {locked && (
                    <div
                        role="note"
                        data-testid="edit-lock-banner"
                        className="rounded px-2.5 py-2"
                        style={{ fontSize: '11.5px', color: 'var(--text-primary)', border: '1px solid var(--warn)', backgroundColor: 'var(--card-bg)' }}
                    >
                        <span style={{ fontWeight: 600, color: 'var(--warn)' }}>Name and formula are locked.</span>{' '}
                        {lockMessage}
                        <div style={{ marginTop: 3, color: 'var(--text-secondary)' }}>
                            You can still change the description, unit and component.
                        </div>
                    </div>
                )}
                <div>
                    <span style={labelStyle}>Name {!locked && <span style={{ color: 'var(--danger)' }}>*</span>}</span>
                    <input
                        aria-label="Name"
                        value={locked ? recipe.tag : tag}
                        onChange={e => setTag(e.target.value)}
                        readOnly={locked}
                        aria-readonly={locked || undefined}
                        style={{ ...fieldStyle, borderColor: tagError ? 'var(--danger)' : undefined, ...(locked ? { opacity: 0.7, cursor: 'not-allowed' } : null) }}
                    />
                    {locked ? null : tagError ? (
                        <p role="alert" style={{ fontSize: '11px', color: 'var(--danger)', marginTop: 3 }}>{tagError}</p>
                    ) : (
                        <p style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 3 }}>
                            Renaming updates every formula and chart setting that points at this sensor. A sensor used by a model can't be renamed.
                        </p>
                    )}
                </div>

                {locked ? (
                    // Locked: the calculation is shown, not editable -- for
                    // either kind, the text the list shows for it.
                    <div>
                        <span style={labelStyle}>{isFormula ? 'Formula' : 'Calculation'}</span>
                        <textarea
                            value={describeRecipe(recipe)}
                            readOnly
                            aria-readonly
                            rows={isFormula ? 3 : 1}
                            spellCheck={false}
                            aria-label={isFormula ? 'Formula' : 'Calculation'}
                            style={{ ...fieldStyle, fontFamily: 'var(--font-mono, monospace)', resize: 'none', opacity: 0.7, cursor: 'not-allowed' }}
                        />
                    </div>
                ) : isFormula ? (
                    <div>
                        <span style={labelStyle}>Formula</span>
                        <textarea
                            value={formula}
                            onChange={e => setFormula(e.target.value)}
                            rows={3}
                            spellCheck={false}
                            aria-label="Formula"
                            style={{ ...fieldStyle, fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
                        />
                        <p style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 3 }}>
                            Reference a sensor as <code>$Name</code>, or <code>{'${Name With Spaces}'}</code>.
                        </p>
                    </div>
                ) : (
                    <>
                        <div>
                            <span style={labelStyle}>Source sensors</span>
                            <div className="flex flex-wrap gap-1.5 mb-1.5">
                                {sources.map(sensor => {
                                    const isBase = pickingBase && (engine.baseSensor || sources[0]) === sensor;
                                    return (
                                        <span
                                            key={sensor}
                                            onClick={pickingBase ? () => engine.setBaseSensor(sensor) : undefined}
                                            className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                                            style={{
                                                fontSize: '11px',
                                                cursor: pickingBase ? 'pointer' : 'default',
                                                backgroundColor: isBase ? 'var(--accent-color)' : 'var(--card-bg)',
                                                color: isBase ? 'white' : 'var(--text-primary)',
                                                border: `1px solid ${isBase ? 'var(--accent-color)' : 'var(--border)'}`,
                                            }}
                                            title={pickingBase ? 'Click to mark as the starting value' : undefined}
                                        >
                                            {isBase && <Star size={9} fill="currentColor" />}
                                            {getSensorName(sensor)}
                                            <button
                                                type="button"
                                                aria-label={`Remove ${sensor}`}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSources(prev => prev.filter(s => s !== sensor));
                                                }}
                                                style={{ color: 'var(--text-faint)', display: 'flex' }}
                                            >
                                                <X size={10} />
                                            </button>
                                        </span>
                                    );
                                })}
                                {sources.length === 0 && (
                                    <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>None picked yet</span>
                                )}
                            </div>
                            <select
                                value=""
                                aria-label="Add a source sensor"
                                onChange={e => {
                                    if (e.target.value) setSources(prev => [...prev, e.target.value]);
                                }}
                                style={fieldStyle}
                            >
                                <option value="">Add a sensor…</option>
                                {addable.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                            {pickingBase && (
                                <p style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 3 }}>
                                    Click a sensor above to mark it as the input.
                                </p>
                            )}
                        </div>

                        {sources.length === 0 ? (
                            <p style={{ fontSize: '11.5px', color: 'var(--text-faint)' }}>
                                Pick at least one sensor above to configure a calculation.
                            </p>
                        ) : (
                            <ButtonBuilder
                                engine={engine}
                                selectedSensors={sources}
                                openChainDropdown={openChainDropdown}
                                setOpenChainDropdown={setOpenChainDropdown}
                                getSensorName={getSensorName}
                            />
                        )}
                    </>
                )}

                <div className="flex gap-2">
                    <div style={{ flex: 2 }}>
                        <span style={labelStyle}>Description <span style={{ color: 'var(--danger)' }}>*</span></span>
                        <input aria-label="Description" value={description} onChange={e => setDescription(e.target.value)} style={fieldStyle} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <span style={labelStyle}>Unit <span style={{ color: 'var(--danger)' }}>*</span></span>
                        <input aria-label="Unit" value={unit} onChange={e => setUnit(e.target.value)} style={fieldStyle} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <span style={labelStyle}>Component <span style={{ color: 'var(--danger)' }}>*</span></span>
                        <ComponentSelect value={component} onChange={setComponent} options={existingComponents} style={fieldStyle} />
                    </div>
                </div>

                {error ? (
                    <p role="alert" style={{ fontSize: '11.5px', color: 'var(--danger)' }}>{error}</p>
                ) : missingFields.length > 0 && (
                    <p style={{ fontSize: '11.5px', color: 'var(--warn)' }}>
                        Fill in {missingFields.join(', ')} before saving.
                    </p>
                )}

                <div className="flex items-center justify-end gap-2">
                    {saving && <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>Recomputing…</span>}
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={saving}
                        className="px-3 py-1 rounded"
                        style={{ fontSize: '12px', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!canSave}
                        className="px-3 py-1 rounded text-white"
                        style={{ fontSize: '12px', fontWeight: 600, backgroundColor: 'var(--accent-color)', opacity: canSave ? 1 : 0.45 }}
                    >
                        Save changes
                    </button>
                </div>
            </div>
        </div>
    );
}
