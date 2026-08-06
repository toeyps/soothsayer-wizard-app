import { useState, useCallback, useEffect, memo } from 'react';
import { Plus, X, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

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

interface FilterPanelProps {
    selectedSensors?: string[];
    filters: FilterState;
    onFiltersChange: (filters: FilterState) => void;
    sensorMetadata?: SensorMetadata[] | null;
}

// ── Styles (stable refs) ────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
    fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
};

const addBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '0.25rem',
    padding: '0.2rem 0.4rem', background: 'rgba(59, 130, 246, 0.1)',
    border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px',
    color: '#3b82f6', fontSize: '0.65rem', fontWeight: 500,
};

const filterRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem',
    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
    borderRadius: '6px',
};

const sensorSelectStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, padding: '0.25rem 0.3rem',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.7rem',
    outline: 'none', cursor: 'pointer',
};

const opSelectStyle: React.CSSProperties = {
    padding: '0.25rem 0.3rem', background: 'rgba(59,130,246,0.1)',
    border: '1px solid rgba(59,130,246,0.25)', borderRadius: '4px',
    color: '#60a5fa', fontSize: '0.65rem', fontWeight: 600,
    outline: 'none', cursor: 'pointer', flexShrink: 0,
};

const valInputStyle: React.CSSProperties = {
    width: '60px', padding: '0.25rem 0.3rem', background: 'var(--input-bg)',
    border: '1px solid var(--border)', borderRadius: '4px',
    color: 'var(--text-primary)', fontSize: '0.7rem', outline: 'none',
    flexShrink: 0,
    // Native spin-button arrows otherwise render in the browser's
    // light-mode chrome (white), clashing with the app's dark theme.
    colorScheme: 'dark',
};

const removeBtnStyle: React.CSSProperties = {
    background: 'transparent', border: 'none', color: 'var(--text-secondary)',
    cursor: 'pointer', padding: '0.15rem', flexShrink: 0, display: 'flex',
};

const clearBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '0.3rem', padding: '0.3rem', background: 'transparent',
    border: '1px dashed var(--border)', borderRadius: '4px',
    color: 'var(--text-secondary)', fontSize: '0.65rem', cursor: 'pointer',
};

const applyBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '0.35rem', padding: '0.4rem 0.75rem',
    background: 'var(--accent-color)', border: 'none', borderRadius: '6px',
    color: '#fff', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
};

const applyBtnDisabledStyle: React.CSSProperties = {
    ...applyBtnStyle,
    opacity: 0.4, cursor: 'default',
};

const emptyStyle: React.CSSProperties = {
    fontSize: '0.7rem', color: 'var(--text-secondary)', opacity: 0.5,
    padding: '0.5rem 0',
};

// ── Filter Row (memoized) ───────────────────────────────────────────────

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
    return (
        <div style={filterRowStyle}>
            <select value={filter.sensor} onChange={(e) => onUpdate(filter.id, 'sensor', e.target.value)} style={sensorSelectStyle}>
                {selectedSensors.map(s => <option key={s} value={s}>{getSensorLabel(s)}</option>)}
            </select>
            <select value={filter.operation} onChange={(e) => onUpdate(filter.id, 'operation', e.target.value)} style={opSelectStyle}>
                <option value="greater_than">&gt;</option>
                <option value="less_than">&lt;</option>
                <option value="between">between</option>
                <option value="equals">=</option>
            </select>
            <input type="number" value={filter.value1} onChange={(e) => onUpdate(filter.id, 'value1', e.target.value)} placeholder="val" style={valInputStyle} />
            {filter.operation === 'between' && (
                <input type="number" value={filter.value2} onChange={(e) => onUpdate(filter.id, 'value2', e.target.value)} placeholder="max" style={valInputStyle} />
            )}
            <button onClick={() => onRemove(filter.id)} style={removeBtnStyle} title="Remove filter">
                <X size={12} />
            </button>
        </div>
    );
});

// ── Main Component ──────────────────────────────────────────────────────

function filtersEqual(a: FilterState, b: FilterState): boolean {
    if (a.timestampStart !== b.timestampStart) return false;
    if (a.timestampEnd !== b.timestampEnd) return false;
    if (a.sensorFilters.length !== b.sensorFilters.length) return false;
    for (let i = 0; i < a.sensorFilters.length; i++) {
        const fa = a.sensorFilters[i];
        const fb = b.sensorFilters[i];
        if (fa.id !== fb.id || fa.sensor !== fb.sensor || fa.operation !== fb.operation || fa.value1 !== fb.value1 || fa.value2 !== fb.value2) return false;
    }
    return true;
}

export default function FilterPanel({
    selectedSensors = [],
    filters,
    onFiltersChange,
    sensorMetadata,
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

    // Sync from parent when parent resets
    useEffect(() => {
        if (!filtersEqual(filters, draft)) {
            setDraft(filters);
        }
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
            sensorFilters: prev.sensorFilters.map(f =>
                f.id === id ? { ...f, [field]: value } : f
            ),
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
        <div className="flex flex-col gap-3 w-full text-sm">
            {/* Sensor Value Filters */}
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span style={labelStyle}>Sensor Filters ({draft.sensorFilters.length})</span>
                    <button
                        onClick={addSensorFilter}
                        disabled={selectedSensors.length === 0}
                        style={{ ...addBtnStyle, cursor: selectedSensors.length > 0 ? 'pointer' : 'not-allowed' }}
                    >
                        <Plus size={10} /> Add
                    </button>
                </div>

                {draft.sensorFilters.length === 0 && (
                    <div style={emptyStyle}>No sensor filters applied.</div>
                )}

                <div className="flex flex-col gap-2">
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
            </div>

            {/* Apply + Clear buttons */}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                    onClick={applyFilters}
                    disabled={!isDirty}
                    style={isDirty ? applyBtnStyle : applyBtnDisabledStyle}
                >
                    <Check size={12} /> Apply Filter
                </button>
                {hasAny && (
                    <button onClick={clearAll} style={clearBtnStyle}>
                        <X size={10} /> Clear
                    </button>
                )}
            </div>
        </div>
    );
}
