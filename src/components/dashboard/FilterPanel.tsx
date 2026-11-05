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

/** Special sensor renamed/deleted: the Dashboard rewrites applied `filters`; this updates the draft. `id` rises per event. */
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
    /** Why 'Show on chart' can't add a sensor now (e.g. Pair Plot cap); the button is disabled with this as its tooltip. */
    showSensorBlockedReason?: string;
}

// Operator pill: 4 small buttons instead of a native <select>.
const OPERATORS: { value: SensorValueFilter['operation']; label: string; title: string }[] = [
    { value: 'greater_than', label: '>', title: 'Greater than' },
    { value: 'less_than', label: '<', title: 'Less than' },
    { value: 'equals', label: '=', title: 'Equals' },
    { value: 'between', label: '↔', title: 'Between' },
];

// One grid row per condition: [sensor] [operator] [value1] [value2 or blank] [delete]; the picker is scoped to chart sensors.
// A condition whose sensor left the chart is kept and still applies: ⚠, amber border, 'Show on chart' / 'Remove' note; never the dashed `.req` look.

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

    // Sync only the half of `filters` that changed (period = timebar, conditions = this panel).
    // Compare each half to what was last synced, not the draft, or a period-only change discards unapplied typing.
    const lastSyncedFilters = useRef<FilterState>(filters);

    // Declared before the sync effect: it applies the same rewrite to `lastSyncedFilters`, so the sync effect leaves the draft alone.
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
                // Leaving 'between' clears value2, so no stale max is sent and switching back starts fresh.
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

    // Conditions only: this panel is "Sensor filters", the time range belongs to the timebar.
    const clearConditions = useCallback(() => {
        setDraft(prev => ({ ...prev, sensorFilters: [] }));
        onFiltersChange({ ...filters, sensorFilters: [] });
    }, [filters, onFiltersChange]);

    const hasAny = draft.sensorFilters.length > 0;

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="filter-panel">
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

            <div className="filter-panel-footer">
                <button
                    onClick={applyFilters}
                    disabled={!isDirty}
                    className="filter-apply-btn"
                >
                    <Check size={12} /> Apply filter
                </button>
                {hasAny && (
                    <button onClick={clearConditions} className="filter-clear-btn">
                        <X size={10} /> Clear conditions
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
