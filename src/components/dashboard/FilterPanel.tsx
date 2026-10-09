import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { Plus, X, Check, AlertTriangle } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { SensorInline } from '../sensor/SensorLabel';
import { SensorPickerSingle } from '../sensor/SensorPicker';
import { SensorMetaContext, useLayeredSensorLookup, useSensorLookup } from '../sensor/sensorInfo';
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
    /** "Show on chart" on a condition whose sensor is no longer on the chart. */
    onShowSensor?: (tag: string) => void;
    /** Why "Show on chart" can't add a sensor right now (e.g. the Pair Plot sensor cap) — the
     *  button is then disabled with this as its tooltip instead of silently doing nothing. */
    showSensorBlockedReason?: string;
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
// [sensor picker] [operator segmented] [value1] [value2 or blank] [delete].
//
// Customer item 3 (SPEC 2026-10-09 §1 "Filter tab"): the sensor is the shared single picker,
// scoped to the sensors on the chart, and the value boxes carry the unit as a suffix. A condition
// whose sensor is no longer on the chart is KEPT and still applies (Dashboard's
// `wireValueFilters` sends every condition) — its row gets a ⚠ and a solid amber picker border,
// and a note under it with "Show on chart" / "Remove". Never the dashed `.req` look (that means
// "required and empty").

const FilterRow = memo(function FilterRow({
    filter,
    selectedSensors,
    onUpdate,
    onRemove,
    onShowSensor,
    showSensorBlockedReason,
}: {
    filter: SensorValueFilter;
    selectedSensors: string[];
    onUpdate: (id: string, field: keyof SensorValueFilter, value: string) => void;
    onRemove: (id: string) => void;
    onShowSensor?: (tag: string) => void;
    showSensorBlockedReason?: string;
}) {
    const lookup = useSensorLookup();
    const isBetween = filter.operation === 'between';
    const offChart = !!filter.sensor && !selectedSensors.includes(filter.sensor);
    const unit = filter.sensor ? lookup(filter.sensor).unit : undefined;
    const valueInput = (field: 'value1' | 'value2', placeholder: string) => (
        <span className="fv-wrap">
            <input
                type="number"
                value={filter[field]}
                onChange={(e) => onUpdate(filter.id, field, e.target.value)}
                placeholder={placeholder}
                className={`filter-row-value${unit ? ' filter-row-value--unit' : ''}`}
            />
            {unit && <span className="fv-unit" aria-hidden="true">{unit}</span>}
        </span>
    );
    return (
        <div className="filter-row-wrap">
            <div className={`filter-row${isBetween ? ' is-between' : ''}`}>
                <div className="filter-row-sensor-cell">
                    {offChart && <AlertTriangle size={13} className="fr-warn-ico" aria-label="Not on the chart" />}
                    <SensorPickerSingle
                        sensors={selectedSensors}
                        value={filter.sensor}
                        onSelect={(t) => { if (t) onUpdate(filter.id, 'sensor', t); }}
                        warn={offChart}
                        scope={<>Sensors on the chart · {selectedSensors.length}</>}
                        ariaLabel="Filter sensor"
                    />
                </div>
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
                {valueInput('value1', isBetween ? 'min' : 'value')}
                {isBetween ? valueInput('value2', 'max') : <span className="fv-empty" />}
                <button onClick={() => onRemove(filter.id)} className="filter-row-delete" title="Remove filter">
                    <X size={12} />
                </button>
            </div>
            {offChart && (
                <div className="filter-row-note" role="status">
                    <span><SensorInline tag={filter.sensor} /> is not on the chart. The filter still applies.</span>
                    {onShowSensor && (
                        <button
                            type="button"
                            disabled={!!showSensorBlockedReason}
                            title={showSensorBlockedReason}
                            onClick={() => onShowSensor(filter.sensor)}
                        >
                            Show on chart
                        </button>
                    )}
                    <button type="button" onClick={() => onRemove(filter.id)}>Remove</button>
                </div>
            )}
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
    onShowSensor,
    showSensorBlockedReason,
}: FilterPanelProps) {
    // Local draft state — edits happen here without triggering heavy recomputation
    const [draft, setDraft] = useState<FilterState>(filters);

    // Labels in the rows (pickers, the off-chart note) read this panel's own metadata, layered on
    // the window's provider.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);

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
        <SensorMetaContext.Provider value={sensorLookup}>
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
                            onUpdate={updateSensorFilter}
                            onRemove={removeSensorFilter}
                            onShowSensor={onShowSensor}
                            showSensorBlockedReason={showSensorBlockedReason}
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
        </SensorMetaContext.Provider>
    );
}
