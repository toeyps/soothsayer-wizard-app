import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
    MultiOperationType,
    SensorMetadata,
    SensorOperationConfig,
    SingleOperationType,
    SpecialSensorRecipe,
} from "../../types";
import { findOperation } from "../../config/operations";

/**
 * Edit one special sensor in place.
 *
 * Everything about the recipe can change here except the sensor's NAME. The
 * name is what other formulas reference (`$name`), what Failure Group models
 * store, and what the chart, colours and axis ranges are keyed by — renaming
 * would have to rewrite all of that at once, and there is no rename-refactor
 * in the app. Create a new sensor and delete this one instead.
 *
 * This component only collects values. Whether the edit is actually allowed —
 * does the formula parse, does it create a cycle — is decided by the caller,
 * which has the backend and the dependency graph; it reports back through
 * `error`.
 */

/** Operations a recipe can actually store — the named multi ops in the
 *  registry (`temp_spread`, `abs_diff`, `efficiency_pct`) are built as
 *  formulas instead, so they arrive here as formula recipes, not operations. */
const SINGLE_OPS: SingleOperationType[] = [
    'add', 'subtract', 'multiply', 'divide', 'power',
    'abs', 'sqrt', 'log10', 'exp', 'ceil', 'floor', 'round',
];
const MULTI_OPS: MultiOperationType[] = ['sum', 'mean', 'median'];

const opLabel = (mode: 'single' | 'multi', id: string) => findOperation(mode, id)?.label ?? id;
const opTakesValue = (id: string) => findOperation('single', id)?.requiresValue ?? false;

interface Props {
    recipe: SpecialSensorRecipe;
    metadata: SensorMetadata | undefined;
    /** Every tag that can be used as an input to an operation recipe. */
    availableSensors: string[];
    onCancel: () => void;
    onSave: (next: { recipe: SpecialSensorRecipe; metadata: SensorMetadata }) => void;
    /** True while the caller is recomputing — the form stays visible but frozen. */
    saving: boolean;
    /** Why the last save attempt was refused, in the user's words. */
    error: string | null;
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

export default function SpecialSensorEditor({
    recipe, metadata, availableSensors, onCancel, onSave, saving, error,
}: Props) {
    const [description, setDescription] = useState(metadata?.description ?? '');
    const [unit, setUnit] = useState(metadata?.unit ?? '');
    const [component, setComponent] = useState(metadata?.component ?? '');

    const [formula, setFormula] = useState(recipe.kind === 'formula' ? recipe.formula : '');
    const [sources, setSources] = useState<string[]>(recipe.kind === 'operation' ? recipe.sourceSensors : []);
    const [config, setConfig] = useState<SensorOperationConfig>(
        recipe.kind === 'operation'
            ? recipe.operationConfig
            : { mode: 'single', singleOp: { type: 'add', value: 0 } },
    );

    const isFormula = recipe.kind === 'formula';
    const singleType = config.singleOp?.type ?? 'add';

    const addable = useMemo(
        () => availableSensors.filter(
            s => s.toLowerCase() !== recipe.tag.toLowerCase()
                && !sources.some(picked => picked.toLowerCase() === s.toLowerCase()),
        ),
        [availableSensors, sources, recipe.tag],
    );

    // What the caller would be asked to save. Single-sensor operations take
    // exactly one input; multi-sensor ones need at least two to combine.
    const sourcesOk = config.mode === 'single' ? sources.length === 1 : sources.length >= 2;
    const canSave = !saving && (isFormula ? formula.trim().length > 0 : sourcesOk);

    const submit = () => {
        const nextMetadata: SensorMetadata = {
            ...(metadata ?? { tag: recipe.tag, description: '', unit: '', component: '' }),
            tag: recipe.tag,
            description: description.trim(),
            unit: unit.trim(),
            component: component.trim() || 'Uncategorized',
        };
        const nextRecipe: SpecialSensorRecipe = isFormula
            ? { kind: 'formula', tag: recipe.tag, formula: formula.trim() }
            : {
                kind: 'operation',
                tag: recipe.tag,
                sourceSensors: sources,
                // The name is forced back so a recomputation can never rename
                // the column out from under everything pointing at it.
                operationConfig: { ...config, customName: recipe.tag },
            };
        onSave({ recipe: nextRecipe, metadata: nextMetadata });
    };

    return (
        <div className="px-3 pb-3 pt-0.5">
            <div
                className="rounded px-3 py-3 flex flex-col gap-3"
                style={{ backgroundColor: 'var(--surface-hi)', border: '1px solid var(--border)' }}
            >
                <div>
                    <span style={labelStyle}>Name</span>
                    <div style={{ ...fieldStyle, opacity: 0.6, cursor: 'not-allowed' }}>{recipe.tag}</div>
                    <p style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 3 }}>
                        Renaming isn’t supported — other formulas and models point at this name.
                        Create a new sensor and delete this one instead.
                    </p>
                </div>

                {isFormula ? (
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
                                {sources.map(sensor => (
                                    <span
                                        key={sensor}
                                        className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                                        style={{ fontSize: '11px', backgroundColor: 'var(--card-bg)', border: '1px solid var(--border)' }}
                                    >
                                        {sensor}
                                        <button
                                            type="button"
                                            aria-label={`Remove ${sensor}`}
                                            onClick={() => setSources(prev => prev.filter(s => s !== sensor))}
                                            style={{ color: 'var(--text-faint)', display: 'flex' }}
                                        >
                                            <X size={10} />
                                        </button>
                                    </span>
                                ))}
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
                            {!sourcesOk && (
                                <p style={{ fontSize: '11px', color: 'var(--warn)', marginTop: 3 }}>
                                    {config.mode === 'single'
                                        ? 'Pick exactly one sensor for this operation.'
                                        : 'Pick at least two sensors to combine.'}
                                </p>
                            )}
                        </div>

                        <div className="flex gap-2">
                            <div style={{ flex: 1 }}>
                                <span style={labelStyle}>Operation</span>
                                {config.mode === 'single' ? (
                                    <select
                                        value={singleType}
                                        aria-label="Operation"
                                        onChange={e => setConfig(c => ({
                                            ...c,
                                            singleOp: { type: e.target.value as SingleOperationType, value: c.singleOp?.value ?? 0 },
                                        }))}
                                        style={fieldStyle}
                                    >
                                        {SINGLE_OPS.map(id => <option key={id} value={id}>{opLabel('single', id)}</option>)}
                                    </select>
                                ) : (
                                    <select
                                        value={config.multiOp?.type ?? 'sum'}
                                        aria-label="Operation"
                                        onChange={e => setConfig(c => ({ ...c, multiOp: { type: e.target.value as MultiOperationType } }))}
                                        style={fieldStyle}
                                    >
                                        {MULTI_OPS.map(id => <option key={id} value={id}>{opLabel('multi', id)}</option>)}
                                    </select>
                                )}
                            </div>
                            {config.mode === 'single' && opTakesValue(singleType) && (
                                <div style={{ width: 110 }}>
                                    <span style={labelStyle}>Value</span>
                                    <input
                                        type="number"
                                        aria-label="Value"
                                        value={config.singleOp?.value ?? 0}
                                        onChange={e => setConfig(c => ({
                                            ...c,
                                            singleOp: { type: c.singleOp?.type ?? 'add', value: Number(e.target.value) },
                                        }))}
                                        style={fieldStyle}
                                    />
                                </div>
                            )}
                        </div>
                    </>
                )}

                <div className="flex gap-2">
                    <div style={{ flex: 2 }}>
                        <span style={labelStyle}>Description</span>
                        <input aria-label="Description" value={description} onChange={e => setDescription(e.target.value)} style={fieldStyle} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <span style={labelStyle}>Unit</span>
                        <input aria-label="Unit" value={unit} onChange={e => setUnit(e.target.value)} style={fieldStyle} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <span style={labelStyle}>Component</span>
                        <input aria-label="Component" value={component} onChange={e => setComponent(e.target.value)} style={fieldStyle} />
                    </div>
                </div>

                {error && (
                    <p role="alert" style={{ fontSize: '11.5px', color: 'var(--danger)' }}>{error}</p>
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
