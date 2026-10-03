import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { Plus, X, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { renameTagInRunningConditionFilters, removeTagsFromFilters } from '../../utils/specialSensorRename';

export interface SensorValueFilter {
    id: string;
    sensor: string;
    operation: 'less_than' | 'greater_than' | 'between' | 'equals';
    value1: string;
    value2: string;
}

export interface FilterState {
    timestampStart: string;
    timestampEnd: string;
    sensorFilters: SensorValueFilter[];
}

/**
 * A special sensor was renamed or deleted (Add Special Sensor window). The
 * Dashboard rewrites the APPLIED `filters` itself; this carries the same change
 * into the panel's own unapplied DRAFT, which the Dashboard cannot see. `id`
 * increments per event so each is applied exactly once.
 */
export interface FilterSensorChange {
    id: number;
    rename?: { from: string; to: string };
    removed?: string[];
}

interface FilterPanelProps {
    selectedSensors?: string[];
    filters: FilterState;
    onFiltersChange: (filters: FilterState) => void;
    sensorMetadata?: SensorMetadata[] | null;
    sensorChange?: FilterSensorChange;
}

// ── Operator segmented control ──────────────────────────────────────────
// Matches the approved prototype's `.op` pill: 4 small buttons instead of
// a native <select> for greater/less/equals/between.
const OPERATORS: { value: SensorValueFilter['operation']; label: string; title: string }[] = [
    { value: 'greater_than', label: '>', title: 'Greater than' },
    { value: 'less_than', label: '<', title: 'Less than' },
    { value: 'equals', label: '=', title: 'Equals' },
    { value: 'between', label: '↔', title: 'Between' },
];

// ── Filter Row (memoized) ───────────────────────────────────────────────
// One grid row per condition — `.frow` in the prototype:
// [sensor select] [operator segmented] [value1] [value2 or blank] [delete].

const FilterRow = memo(function FilterRow({
    filter,
    selectedSensors,
    getSensorLabel,
    onUpdate,
    onRemove,
}: {
    filter: SensorValueFilter;
    selectedSensors: string[];
    getSensorLabel: (sensor: string) => string;
    onUpdate: (id: string, field: keyof SensorValueFilter, value: string) => void;
    onRemove: (id: string) => void;
}) {
    const isBetween = filter.operation === 'between';
    return (
        <div className="filter-row">
            <select
                value={filter.sensor}
                onChange={(e) => onUpdate(filter.id, 'sensor', e.target.value)}
                className="filter-row-sensor"
            >
                {selectedSensors.map(s => <option key={s} value={s}>{getSensorLabel(s)}</option>)}
            </select>
            <div className="filter-op-seg">
                {OPERATORS.map(op => (
                    <button
                        key={op.value}
                        type="button"
                        className={filter.operation === op.value ? 'is-on' : ''}
                        onClick={() => onUpdate(filter.id, 'operation', op.value)}
                        title={op.title}
                    >
                        {op.label}
                    </button>
                ))}
            </div>
            <input
                type="number"
                value={filter.value1}
                onChange={(e) => onUpdate(filter.id, 'value1', e.target.value)}
                placeholder={isBetween ? 'min' : 'value'}
                className="filter-row-value"
            />
            {isBetween ? (
                <input
                    type="number"
                    value={filter.value2}
                    onChange={(e) => onUpdate(filter.id, 'value2', e.target.value)}
                    placeholder="max"
                    className="filter-row-value"
                />
            ) : <span />}
            <button onClick={() => onRemove(filter.id)} className="filter-row-delete" title="Remove filter">
                <X size={12} />
            </button>
        </div>
    );
});

// ── Main Component ──────────────────────────────────────────────────────

function sensorFiltersEqual(a: SensorValueFilter[], b: SensorValueFilter[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const fa = a[i];
        const fb = b[i];
        if (fa.id !== fb.id || fa.sensor !== fb.sensor || fa.operation !== fb.operation || fa.value1 !== fb.value1 || fa.value2 !== fb.value2) return false;
    }
    return true;
}

function filtersEqual(a: FilterState, b: FilterState): boolean {
    if (a.timestampStart !== b.timestampStart) return false;
    if (a.timestampEnd !== b.timestampEnd) return false;
    return sensorFiltersEqual(a.sensorFilters, b.sensorFilters);
}

export default function FilterPanel({
    selectedSensors = [],
    filters,
    onFiltersChange,
    sensorMetadata,
    sensorChange,
}: FilterPanelProps) {
    // Local draft state — edits happen here without triggering heavy recomputation
    const [draft, setDraft] = useState<FilterState>(filters);

    // "<description> (<tag>)" when metadata is loaded — a bare tag like
    // "11EI1301.PV" isn't enough to tell which sensor it is at a glance.
    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getSensorLabel = useCallback((sensor: string) => {
        const meta = sensorMetaMap.get(normalizeSensorTag(sensor));
        return meta ? `${meta.description} (${sensor})` : sensor;
    }, [sensorMetaMap]);

    // Sync from parent -- but only the pieces that actually changed
    // upstream. `filters` bundles BOTH the time period (timestampStart/End
    // -- owned by the Dashboard timebar; Reset period, Apply relative
    // range and editing start/end all funnel through this same prop) AND
    // the sensor value conditions this panel itself edits. The original
    // version re-derived the WHOLE draft whenever `filters` differed from
    // the CURRENT DRAFT -- so an unrelated period-only change (the draft
    // now contains an unapplied condition `filters` never had) looked
    // identical to an external reset and silently discarded the user's
    // in-progress typing. Comparing each half of `filters` against what
    // was last synced FROM the parent -- not against the current draft --
    // lets a period change update only the period half, leaving a
    // locally-edited sensorFilters draft alone unless the parent's own
    // sensorFilters has genuinely moved on (e.g. Apply/Clear from this
    // panel itself, or an external reset such as a workspace reload).
    const lastSyncedFilters = useRef<FilterState>(filters);

    // A special sensor's rename / deletion, carried into the draft. Declared
    // BEFORE the sync effect below on purpose: it applies the same rewrite to
    // `lastSyncedFilters` too, so when the sync effect then sees the Dashboard's
    // already-rewritten applied filters they match what it last synced and it
    // leaves the draft (with any unapplied typing) alone.
    const lastChangeId = useRef(sensorChange?.id ?? 0);
    useEffect(() => {
        if (!sensorChange || sensorChange.id === lastChangeId.current) return;
        lastChangeId.current = sensorChange.id;
        const apply = <T extends { sensor: string }>(list: T[]): T[] => {
            let out = list;
            if (sensorChange.rename) out = renameTagInRunningConditionFilters(out, sensorChange.rename.from, sensorChange.rename.to);
            if (sensorChange.removed) out = removeTagsFromFilters(out, sensorChange.removed);
            return out;
        };
        setDraft(prev => {
            const next = apply(prev.sensorFilters);
            return next === prev.sensorFilters ? prev : { ...prev, sensorFilters: next };
        });
        lastSyncedFilters.current = {
            ...lastSyncedFilters.current,
            sensorFilters: apply(lastSyncedFilters.current.sensorFilters),
        };
    }, [sensorChange]);

    useEffect(() => {
        const prevSynced = lastSyncedFilters.current;
        const periodChanged = filters.timestampStart !== prevSynced.timestampStart || filters.timestampEnd !== prevSynced.timestampEnd;
        const sensorFiltersChanged = !sensorFiltersEqual(filters.sensorFilters, prevSynced.sensorFilters);
        if (periodChanged || sensorFiltersChanged) {
            setDraft(prev => ({
                timestampStart: periodChanged ? filters.timestampStart : prev.timestampStart,
                timestampEnd: periodChanged ? filters.timestampEnd : prev.timestampEnd,
                sensorFilters: sensorFiltersChanged ? filters.sensorFilters : prev.sensorFilters,
            }));
        }
        lastSyncedFilters.current = filters;
    }, [filters]);

    const isDirty = !filtersEqual(draft, filters);

    const addSensorFilter = useCallback(() => {
        if (selectedSensors.length === 0) return;
        setDraft(prev => ({
            ...prev,
            sensorFilters: [...prev.sensorFilters, {
                id: `f-${Date.now()}-${Math.random()}`,
                sensor: selectedSensors[0],
                operation: 'greater_than',
                value1: '',
                value2: '',
            }],
        }));
    }, [selectedSensors]);

    const removeSensorFilter = useCallback((id: string) => {
        setDraft(prev => ({
            ...prev,
            sensorFilters: prev.sensorFilters.filter(f => f.id !== id),
        }));
    }, []);

    const updateSensorFilter = useCallback((id: string, field: keyof SensorValueFilter, value: string) => {
        setDraft(prev => ({
            ...prev,
            sensorFilters: prev.sensorFilters.map(f => {
                if (f.id !== id) return f;
                // Switching away from "between" hides the max-value input
                // (see FilterRow above) -- clear its value with it, so a
                // leftover max from an earlier "between" isn't silently
                // carried in the draft/wire payload for an operator that no
                // longer shows or uses it, and switching back to "between"
                // starts fresh instead of resurrecting the old number.
                if (field === 'operation' && value !== 'between') {
                    return { ...f, operation: value as SensorValueFilter['operation'], value2: '' };
                }
                return { ...f, [field]: value };
            }),
        }));
    }, []);

    const applyFilters = useCallback(() => {
        onFiltersChange(draft);
    }, [draft, onFiltersChange]);

    const clearAll = useCallback(() => {
        const empty: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [] };
        setDraft(empty);
        onFiltersChange(empty);
    }, [onFiltersChange]);

    const hasAny = draft.sensorFilters.length > 0;

    return (
        <div className="filter-panel">
            {/* Header -- `.fhead` in the prototype: bold title + hint text +
                spacer + "Add condition" (disabled with no sensors to pick
                from). Replaces the old "SENSOR FILTERS (N)" caps label. */}
            <div className="filter-panel-head">
                <b>Sensor filters</b>
                <span className="filter-panel-hint">Show only rows that match every condition</span>
                <span className="filter-panel-spacer" />
                <button
                    onClick={addSensorFilter}
                    disabled={selectedSensors.length === 0}
                    className="filter-add-btn"
                >
                    <Plus size={12} /> Add condition
                </button>
            </div>

            {draft.sensorFilters.length === 0 ? (
                <div className="filter-empty">No sensor filters applied.</div>
            ) : (
                <div className="filter-rows">
                    {draft.sensorFilters.map((filter) => (
                        <FilterRow
                            key={filter.id}
                            filter={filter}
                            selectedSensors={selectedSensors}
                            getSensorLabel={getSensorLabel}
                            onUpdate={updateSensorFilter}
                            onRemove={removeSensorFilter}
                        />
                    ))}
                </div>
            )}

            {/* Footer -- Apply (primary, disabled unless dirty) + Clear
                (ghost, only when there's something to clear) + spacer +
                a dirty-state hint on the right, matching the prototype. */}
            <div className="filter-panel-footer">
                <button
                    onClick={applyFilters}
                    disabled={!isDirty}
                    className="filter-apply-btn"
                >
                    <Check size={12} /> Apply filter
                </button>
                {hasAny && (
                    <button onClick={clearAll} className="filter-clear-btn">
                        <X size={10} /> Clear
                    </button>
                )}
                <span className="filter-panel-spacer" />
                {isDirty && (
                    <span className="filter-dirty-hint">Changes not applied yet</span>
                )}
            </div>
        </div>
    );
}
