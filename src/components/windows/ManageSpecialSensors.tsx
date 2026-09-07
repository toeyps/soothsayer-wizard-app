import { useMemo, useState } from "react";
import { Trash2, Lock, Search, Undo2 } from "lucide-react";
import { FailureModel, SensorMetadata, SpecialSensorRecipe } from "../../types";
import { buildSpecialSensorUsage, usageFor, SpecialSensorUsage } from "../../utils/specialSensorDeps";

interface Props {
    /** Special sensors to list — already excluding anything in an open undo
     *  window, so a deleted row disappears the moment it is deleted. */
    recipes: SpecialSensorRecipe[];
    sensorMetadata: SensorMetadata[] | null;
    /** Every Failure Group model, from the dashboard. A model referencing a
     *  special sensor is one of the two things that blocks deleting it. */
    models: FailureModel[];
    /** Sensors currently plotted on the dashboard chart. */
    selectedSensors: string[];
    /** Formula tag -> sensors its expression references, from Rust's
     *  `extract_formula_refs`. Null while that lookup is still in flight:
     *  deletion is held back until it lands, since an incomplete map would
     *  under-report dependencies and let a depended-on sensor be deleted. */
    formulaRefs: Map<string, string[]> | null;
    onDelete: (tag: string) => void;
    /** Set while a deletion is inside its undo window. */
    pendingDelete: { tags: string[]; label: string } | null;
    onUndo: () => void;
}

/** How the recipe reads in the list — the formula as typed, or the operation
 *  spelled out as `sum(a, b)` / `a + 10`. */
function describeRecipe(recipe: SpecialSensorRecipe): string {
    if (recipe.kind === 'formula') return recipe.formula;
    const sources = recipe.sourceSensors.join(', ');
    const config = recipe.operationConfig;
    if (config.mode === 'multi') return `${config.multiOp?.type ?? 'sum'}(${sources})`;
    const op = config.singleOp;
    if (!op) return sources;
    switch (op.type) {
        case 'add': return `${sources} + ${op.value}`;
        case 'subtract': return `${sources} - ${op.value}`;
        case 'multiply': return `${sources} × ${op.value}`;
        case 'divide': return `${sources} ÷ ${op.value}`;
        case 'power': return `${sources} ^ ${op.value}`;
        default: return `${op.type}(${sources})`;
    }
}

/** One line saying why the delete button is off — the short version that fits
 *  on the row; the full list is in the expanded panel. */
function blockedSummary(usage: SpecialSensorUsage): string | null {
    const parts: string[] = [];
    if (usage.dependentSensors.length > 0) {
        parts.push(`${usage.dependentSensors.length} sensor${usage.dependentSensors.length > 1 ? 's' : ''}`);
    }
    if (usage.modelReferences.length > 0) {
        const models = new Set(usage.modelReferences.map(r => r.modelId));
        parts.push(`${models.size} model${models.size > 1 ? 's' : ''}`);
    }
    return parts.length > 0 ? `Used by ${parts.join(' and ')}` : null;
}

export default function ManageSpecialSensors({
    recipes, sensorMetadata, models, selectedSensors, formulaRefs, onDelete, pendingDelete, onUndo,
}: Props) {
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedTag, setExpandedTag] = useState<string | null>(null);

    const usage = useMemo(
        () => buildSpecialSensorUsage({
            recipes,
            formulaRefs: formulaRefs ?? new Map(),
            models,
            selectedSensors,
        }),
        [recipes, formulaRefs, models, selectedSensors],
    );

    const metaFor = (tag: string) => sensorMetadata?.find(m => m.tag.toLowerCase() === tag.toLowerCase());

    const visible = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        if (!term) return recipes;
        return recipes.filter(r => {
            const meta = metaFor(r.tag);
            const haystack = `${r.tag} ${meta?.description ?? ''} ${meta?.component ?? ''} ${describeRecipe(r)}`.toLowerCase();
            return haystack.includes(term);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recipes, searchTerm, sensorMetadata]);

    if (recipes.length === 0 && !pendingDelete) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-2 px-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>No special sensors yet</p>
                <p style={{ fontSize: '12px' }}>
                    Build one on the Create tab — formulas and operations both show up here,
                    where you can delete the ones you no longer need.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Search */}
            <div className="shrink-0 px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded" style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}>
                    <Search size={13} style={{ color: 'var(--text-faint)' }} />
                    <input
                        type="text"
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        placeholder="Search special sensors"
                        className="flex-1 bg-transparent outline-none"
                        style={{ fontSize: '12px', color: 'var(--text-primary)' }}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>{visible.length} / {recipes.length}</span>
                </div>
            </div>

            {/* Rows */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-1.5">
                {visible.length === 0 && (
                    <p className="py-6 text-center" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        Nothing matches “{searchTerm}”.
                    </p>
                )}
                {visible.map(recipe => {
                    const info = usageFor(usage, recipe.tag)!;
                    const meta = metaFor(recipe.tag);
                    const summary = blockedSummary(info);
                    // Deletion stays off until the reference lookup has
                    // actually answered — see `formulaRefs` above.
                    const canDelete = info.deletable && formulaRefs !== null;
                    const expanded = expandedTag === recipe.tag;
                    return (
                        <div key={recipe.tag} className="rounded" style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                            <div className="flex items-center gap-3 px-3 py-2.5">
                                <span
                                    className="flex items-center justify-center shrink-0 rounded"
                                    title={recipe.kind === 'formula' ? 'Formula' : 'Operation'}
                                    style={{
                                        width: 22, height: 22, fontSize: '12px', fontWeight: 700,
                                        backgroundColor: 'var(--surface-hi)',
                                        color: recipe.kind === 'formula' ? 'var(--accent-color)' : 'var(--kind-clu)',
                                    }}
                                >
                                    {recipe.kind === 'formula' ? 'ƒ' : 'Σ'}
                                </span>

                                <div className="min-w-0 flex-1">
                                    <div className="truncate" style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                        {recipe.tag}
                                    </div>
                                    <div className="truncate" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                        {meta?.description || '— no description —'}
                                        {meta?.unit ? ` · ${meta.unit}` : ''}
                                    </div>
                                </div>

                                <div
                                    className="hidden md:block truncate"
                                    title={describeRecipe(recipe)}
                                    style={{ flex: '0 1 240px', fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', color: 'var(--text-secondary)' }}
                                >
                                    {describeRecipe(recipe)}
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                    {info.onChart && (
                                        <span className="px-1.5 py-0.5 rounded" style={{ fontSize: '10px', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                            on chart
                                        </span>
                                    )}
                                    {summary && (
                                        <button
                                            type="button"
                                            onClick={() => setExpandedTag(expanded ? null : recipe.tag)}
                                            aria-expanded={expanded}
                                            className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                                            style={{ fontSize: '10px', color: 'var(--warn)', border: '1px solid var(--warn)' }}
                                        >
                                            <Lock size={9} />
                                            {summary}
                                        </button>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    onClick={() => onDelete(recipe.tag)}
                                    disabled={!canDelete}
                                    title={canDelete ? `Delete ${recipe.tag}` : 'Something still uses this sensor'}
                                    aria-label={`Delete ${recipe.tag}`}
                                    className="flex items-center justify-center shrink-0 rounded"
                                    style={{
                                        width: 26, height: 26,
                                        color: canDelete ? 'var(--danger)' : 'var(--text-faint)',
                                        border: `1px solid ${canDelete ? 'var(--danger)' : 'var(--border)'}`,
                                        opacity: canDelete ? 1 : 0.4,
                                        cursor: canDelete ? 'pointer' : 'not-allowed',
                                    }}
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>

                            {expanded && summary && (
                                <div className="px-3 pb-3 pt-0.5" style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                                    <div className="rounded px-3 py-2.5 flex flex-col gap-1.5" style={{ backgroundColor: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
                                        {info.dependentSensors.length > 0 && (
                                            <div>
                                                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Built on top of this:</span>{' '}
                                                {info.dependentSensors.join(', ')}
                                                <div style={{ marginTop: 2 }}>Delete those first, then this one can go.</div>
                                            </div>
                                        )}
                                        {info.modelReferences.length > 0 && (
                                            <div>
                                                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Used by models:</span>
                                                <ul className="mt-1 flex flex-col gap-0.5">
                                                    {info.modelReferences.map(ref => (
                                                        <li key={`${ref.modelId}:${ref.field}`}>
                                                            {ref.modelName || 'Untitled model'}
                                                            <span style={{ color: 'var(--text-faint)' }}> — {ref.field}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                                <div style={{ marginTop: 2 }}>Take it out of those models (or delete them) first.</div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Undo bar — deletion is applied here immediately and reaches the
                dashboard once this window closes, so undo costs nothing. */}
            {pendingDelete && (
                <div
                    className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-t"
                    style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-hi)' }}
                >
                    <span className="flex-1 truncate" style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                        Deleted <b>{pendingDelete.label}</b>
                    </span>
                    <button
                        type="button"
                        onClick={onUndo}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded"
                        style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-color)', border: '1px solid var(--accent-color)' }}
                    >
                        <Undo2 size={12} />
                        Undo
                    </button>
                </div>
            )}
        </div>
    );
}
