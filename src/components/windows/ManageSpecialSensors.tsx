import { useMemo, useState } from "react";
import { Trash2, Lock, Search, Undo2, Pencil, AlertTriangle } from "lucide-react";
import { FailureModel, SensorMetadata, SpecialSensorRecipe } from "../../types";
import { buildSpecialSensorUsage, describeEditLock, usageFor, SpecialSensorUsage } from "../../utils/specialSensorDeps";
import { describeSpecialSensor } from "../../utils/specialSensorDescribe";
import { SensorLabel } from '../sensor/SensorLabel';

interface Props {
    /** Special sensors to list — already excluding anything in an open undo
     *  window, so a deleted row disappears the moment it is deleted. */
    recipes: SpecialSensorRecipe[];
    sensorMetadata: SensorMetadata[] | null;
    /** Every Failure Group model, from the dashboard. A model referencing a
     *  special sensor is one of the two things that blocks deleting it. */
    models: FailureModel[];
    /** False while this window does not know the models / running condition
     *  FRESH (never received, or the last re-read failed): deletion is held
     *  back, because "no model uses it" would be a guess. */
    usageKnown?: boolean;
    /** The workspace Running condition's conditions: naming a special sensor
     *  there also blocks its deletion (Rust silently ignores a condition on a
     *  column that no longer exists, so models would train on other rows). */
    runningConditionFilters?: Array<{ sensor: string }>;
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
    /** The sensor open in the Formula editor (Create tab, titled "Edit sensor"), if any. */
    editingTag: string | null;
    /** The pencil opens the sensor in the Formula editor (customer batch 2026-10, item 6 — the
     *  inline editor this list used to expand is gone). */
    onEdit: (tag: string) => void;
    /** A save is being applied: the pencil buttons wait. */
    savingEdit: boolean;
    /** Special sensors whose recipe could not be rebuilt this session (no
     *  column): tag key (trimmed, lower-case) -> why, or null for "no specific
     *  reason". Their formula / sources stay editable even when a model uses
     *  them (only the name is locked then) -- otherwise a locked sensor with a
     *  refused recipe could never be fixed. Null / omitted = unknown (nothing
     *  is unlocked). */
    unrestored?: Map<string, string | null> | null;
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
    if (usage.runningCondition) parts.push('the running condition');
    return parts.length > 0 ? `Used by ${parts.join(' and ')}` : null;
}

export default function ManageSpecialSensors({
    recipes, sensorMetadata, models, usageKnown = true, runningConditionFilters,
    selectedSensors, formulaRefs, onDelete, pendingDelete, onUndo,
    editingTag, onEdit, savingEdit, unrestored,
}: Props) {
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedTag, setExpandedTag] = useState<string | null>(null);

    const usage = useMemo(
        () => buildSpecialSensorUsage({
            recipes,
            formulaRefs: formulaRefs ?? new Map(),
            models,
            runningConditionFilters,
            selectedSensors,
            // Until both lookups have answered, "nothing uses it" would be a
            // guess -- the edit lock then holds name / formula / sources back.
            failureKnown: usageKnown && formulaRefs !== null,
        }),
        [recipes, formulaRefs, models, runningConditionFilters, selectedSensors, usageKnown],
    );

    const metaFor = (tag: string) => sensorMetadata?.find(m => m.tag.toLowerCase() === tag.toLowerCase());

    // One human line per recipe (customer batch 2026-10, item 6): sources read by their
    // description in a block / operation; a formula keeps its own `$TAG` text.
    const descriptions = useMemo(() => {
        const label = (tag: string) => sensorMetadata?.find(m => m.tag.toLowerCase() === tag.toLowerCase())?.description?.trim() || tag;
        return new Map(recipes.map(r => [r.tag, describeSpecialSensor(r, { label })]));
    }, [recipes, sensorMetadata]);

    const visible = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        if (!term) return recipes;
        return recipes.filter(r => {
            const meta = metaFor(r.tag);
            const d = descriptions.get(r.tag);
            const haystack = `${r.tag} ${meta?.description ?? ''} ${meta?.component ?? ''} ${d?.summary ?? ''} ${d?.expression ?? ''}`.toLowerCase();
            return haystack.includes(term);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recipes, searchTerm, sensorMetadata, descriptions]);

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
                    // Edit lock: why this sensor's name / formula / sources are
                    // frozen (a model uses it, or one built on it does). The
                    // description / unit / component stay editable.
                    const lockMessage = info.editLock.locked ? describeEditLock(info.editLock) : null;
                    // Its recipe could not be rebuilt this session: it has no
                    // data until fixed, and the editor lets the formula be
                    // fixed even under a lock (the name stays locked).
                    const unrestoredKey = recipe.tag.trim().toLowerCase();
                    const notRestored = !!unrestored?.has(unrestoredKey);
                    const notRestoredReason = unrestored?.get(unrestoredKey) ?? null;
                    // Deletion stays off until the reference lookup has
                    // actually answered — see `formulaRefs` above — and until
                    // the models / running condition are known fresh.
                    // The sensor open in the editor cannot be deleted under it (review
                    // 2026-10-09): close the edit first.
                    const isEditing = editingTag !== null && editingTag.toLowerCase() === recipe.tag.toLowerCase();
                    const canDelete = info.deletable && formulaRefs !== null && usageKnown && !isEditing;
                    // Why Delete is off, in one line (its tooltip): "Used by X — remove it there first".
                    const deleteReason = canDelete ? `Delete ${recipe.tag}`
                        : isEditing ? 'Close the edit first'
                        : info.deletable ? 'Still checking what uses this sensor'
                            : info.dependentSensors.length > 0 ? `Used by ${info.dependentSensors.join(', ')} — remove it there first`
                                : `${summary ?? 'Something still uses this sensor'} — remove it there first`;
                    const expanded = expandedTag === recipe.tag;
                    const desc = descriptions.get(recipe.tag);
                    return (
                        <div key={recipe.tag} className="rounded" style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                            <div className="flex items-center gap-3 px-3 py-2.5">
                                <span
                                    className="flex items-center justify-center shrink-0 rounded"
                                    title={desc?.kindLabel ?? (recipe.kind === 'formula' ? 'Formula' : 'Operation')}
                                    style={{
                                        width: 22, height: 22, fontSize: '12px', fontWeight: 700,
                                        backgroundColor: 'var(--surface-hi)',
                                        color: recipe.kind === 'formula' ? 'var(--accent-color)' : 'var(--kind-clu)',
                                    }}
                                >
                                    {recipe.kind === 'formula' ? 'ƒ' : 'Σ'}
                                </span>

                                {/* Customer item 3: description first, unit chip, tag on line 2 — the
                                    ƒ / Σ badge is already the square on the left, so it is not repeated.
                                    No "no description" placeholder (the tag stands alone). */}
                                <div className="min-w-0 flex-1 manage-ss-label">
                                    <SensorLabel
                                        tag={recipe.tag}
                                        info={{ tag: recipe.tag, description: meta?.description?.trim() || undefined, unit: meta?.unit?.trim() || undefined, component: meta?.component?.trim() || undefined }}
                                    />
                                </div>

                                <div
                                    className="hidden md:block truncate"
                                    title={desc?.expression}
                                    data-testid={`recipe-summary-${recipe.tag}`}
                                    style={{ flex: '0 1 260px', fontFamily: recipe.kind === 'formula' ? 'var(--mono)' : undefined, fontSize: '11px', color: 'var(--text-secondary)' }}
                                >
                                    {desc?.summary}
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                    {notRestored && (
                                        <span
                                            data-testid={`not-restored-${recipe.tag}`}
                                            title={notRestoredReason
                                                ? `No data: ${notRestoredReason}. Edit it to fix the formula.`
                                                : 'No data: it could not be rebuilt. Edit it to fix the formula.'}
                                            className="special-sensor-nodata"
                                        >
                                            <AlertTriangle size={9} />
                                            No data — fix formula
                                        </span>
                                    )}
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
                                            style={{ fontSize: '10px', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)' }}
                                        >
                                            {/* Customer item 3: a neutral grey lock pill (a lock is not a warning). */}
                                            <Lock size={9} />
                                            {summary}
                                        </button>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    onClick={() => onEdit(recipe.tag)}
                                    disabled={savingEdit}
                                    title={`Edit ${recipe.tag}`}
                                    aria-label={`Edit ${recipe.tag}`}
                                    aria-pressed={isEditing}
                                    className="flex items-center justify-center shrink-0 rounded"
                                    style={{
                                        width: 26, height: 26,
                                        color: isEditing ? 'var(--accent-color)' : 'var(--text-secondary)',
                                        border: `1px solid ${isEditing ? 'var(--accent-color)' : 'var(--border)'}`,
                                    }}
                                >
                                    <Pencil size={13} />
                                </button>

                                <button
                                    type="button"
                                    onClick={() => onDelete(recipe.tag)}
                                    disabled={!canDelete}
                                    title={deleteReason}
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

                            {notRestored && (
                                <div className="special-sensor-nodata-note" data-testid={`not-restored-note-${recipe.tag}`}>
                                    <b>No data this session.</b>{' '}
                                    {notRestoredReason ? `${notRestoredReason.replace(/[.\s]+$/, '')}. ` : 'Its formula could not be rebuilt. '}
                                    Edit it to fix the formula{lockMessage ? ' — the formula is unlocked for the fix; the name stays locked' : ''}.
                                </div>
                            )}
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
                                        {info.runningCondition && (
                                            <div>
                                                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Used by the running condition:</span>{' '}
                                                the workspace's Running condition has a condition on this sensor.
                                                <div style={{ marginTop: 2 }}>Remove that condition (Build Model → Running condition) first.</div>
                                            </div>
                                        )}
                                        {lockMessage && (
                                            <div data-testid={`edit-lock-${recipe.tag}`}>
                                                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                                    {notRestored ? 'Name is locked:' : 'Name and formula are locked:'}
                                                </span>{' '}
                                                {lockMessage}
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
