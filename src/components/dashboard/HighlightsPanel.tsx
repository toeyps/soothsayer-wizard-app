import { useState, useEffect } from 'react';
import { X, AlertCircle, Pencil } from 'lucide-react';
import type { TimeHighlight, ValueHighlight } from '../../types';
import ColourPicker from '../sensor/ColourPicker';
import { SensorPickerSingle } from '../sensor/SensorPicker';
import { fmtNumExact, useSensorLookup } from '../sensor/sensorInfo';
import { formatDateTimeMinutes } from '../../utils/dateFormat';
import { DateTime24Input } from '../windows/DateTime24Input';

interface HighlightsPanelProps {
    // "By time" -- timestamp windows, read by Line + Scatter (not Pair Plot).
    timeHighlights: TimeHighlight[];
    onAddTimeHighlight: (start: string, end: string, label: string) => void;
    onToggleTimeHighlight: (id: string) => void;
    onRemoveTimeHighlight: (id: string) => void;
    onRecolorTimeHighlight: (id: string, color: string) => void;
    onRenameTimeHighlight: (id: string, label: string) => void;

    // 'By value': one sensor + value ranges colouring Scatter points; Scatter only.
    valueHighlight: ValueHighlight;
    /** Sensors selectable in the "Colour by…" dropdown -- same pool
     *  ScatterChart itself plots (Dashboard's `scatterChartHeaders`). */
    valueHighlightSensors: string[];
    onSetValueHighlightSensor: (sensor: string) => void;
    onAddValueHighlightRange: (min: number, max: number) => void;
    onToggleValueHighlightRange: (id: string) => void;
    onRemoveValueHighlightRange: (id: string) => void;
    onRecolorValueHighlightRange: (id: string, color: string) => void;

    /** Chart on screen: on Pair Plot the 'By time' body is a disabled fieldset with a banner, not merely dimmed. */
    chartType: 'line' | 'scatter' | 'pair';
    /** First and last time of the data: the calendar opens there and stays inside. */
    dataStart?: string;
    dataEnd?: string;
}

/** A highlight's two bounds in the app's date format (date + time, no seconds). */
function fmtRange(start: string, end: string): string {
    const f = (s: string) => {
        const d = new Date(s);
        return isNaN(d.getTime()) ? '?' : formatDateTimeMinutes(d);
    };
    return `${f(start)} → ${f(end)}`;
}

/** Highlights tab: 'By time' (Line + Scatter) and 'By value' (Scatter only) side by side; owns only draft-form and popover state. */
export default function HighlightsPanel({
    timeHighlights, onAddTimeHighlight, onToggleTimeHighlight, onRemoveTimeHighlight, onRecolorTimeHighlight,
    onRenameTimeHighlight,
    valueHighlight, valueHighlightSensors, onSetValueHighlightSensor, onAddValueHighlightRange,
    onToggleValueHighlightRange, onRemoveValueHighlightRange, onRecolorValueHighlightRange,
    chartType, dataStart, dataEnd,
}: HighlightsPanelProps) {
    const highlightApplies = chartType !== 'pair';
    // "By value" only ever does anything on Scatter -- Line has no 3rd-
    // sensor colour channel and Pair Plot keeps its own lasso-cluster.
    const valueHighlightApplies = chartType === 'scatter';

    const [draftStart, setDraftStart] = useState('');
    const [draftEnd, setDraftEnd] = useState('');
    const [draftLabel, setDraftLabel] = useState('');
    const [highlightError, setHighlightError] = useState<string | null>(null);
    // Which chip's label is being edited inline, and its draft value.
    const [editLabelFor, setEditLabelFor] = useState<string | null>(null);
    const [draftEditLabel, setDraftEditLabel] = useState('');

    // "By value" draft-form state -- mirrors the "By time" block above.
    const [draftRangeMin, setDraftRangeMin] = useState('');
    const [draftRangeMax, setDraftRangeMax] = useState('');
    const [rangeError, setRangeError] = useState<string | null>(null);

    // The "By value" range chips and inputs show the Colour-by sensor's unit.
    const lookup = useSensorLookup();
    const unit = valueHighlight.sensor ? lookup(valueHighlight.sensor).unit : undefined;

    // Clear the rename draft on any chart switch (layout shifts); colour pickers are keyed by chart type so they remount closed.
    useEffect(() => {
        setEditLabelFor(null);
    }, [chartType]);

    const handleAddRange = () => {
        const min = parseFloat(draftRangeMin);
        const max = parseFloat(draftRangeMax);
        if (!isFinite(min) || !isFinite(max)) { setRangeError('Enter valid numbers'); return; }
        if (min >= max) { setRangeError('Min must be less than max'); return; }
        onAddValueHighlightRange(min, max);
        setDraftRangeMin(''); setDraftRangeMax(''); setRangeError(null);
    };

    const handleAddHighlight = () => {
        if (!draftStart || !draftEnd) { setHighlightError('Pick a start and end'); return; }
        if (new Date(draftStart).getTime() >= new Date(draftEnd).getTime()) {
            setHighlightError('Start must be before end'); return;
        }
        onAddTimeHighlight(draftStart, draftEnd, draftLabel.trim());
        setDraftStart(''); setDraftEnd(''); setDraftLabel(''); setHighlightError(null);
    };

    const startEditLabel = (h: TimeHighlight) => {
        setEditLabelFor(h.id);
        setDraftEditLabel(h.label);
    };
    // Empty labels revert instead of saving: an untitled chip is hard to pick out.
    const commitEditLabel = () => {
        if (!editLabelFor) return;
        const trimmed = draftEditLabel.trim();
        if (trimmed) onRenameTimeHighlight(editLabelFor, trimmed);
        setEditLabelFor(null);
    };
    const cancelEditLabel = () => setEditLabelFor(null);

    return (
        <div className="highlights-grid">
            <div className="highlights-col">
                <div className="highlights-col-head">
                    <span className="highlights-col-title">By time</span>
                    <span className="highlights-col-hint">Line + Scatter</span>
                </div>

                {!highlightApplies && (
                    <div className="highlights-note">
                        <AlertCircle size={13} />
                        <span>Not shown on <b>Pair Plot</b> — it uses its own lasso clusters.</span>
                    </div>
                )}

                <fieldset disabled={!highlightApplies} className={`highlights-fieldset${highlightApplies ? '' : ' highlights-fieldset--dim'}`}>
                    <div className="highlights-add-row">
                        <div className="f4-dtw highlights-date">
                            <DateTime24Input ariaLabel="Highlight start" value={draftStart} min={dataStart} max={dataEnd} onChange={v => { setDraftStart(v); setHighlightError(null); }} />
                        </div>
                        <span className="highlights-add-sep">→</span>
                        <div className="f4-dtw highlights-date">
                            <DateTime24Input ariaLabel="Highlight end" value={draftEnd} min={dataStart} max={dataEnd} onChange={v => { setDraftEnd(v); setHighlightError(null); }} />
                        </div>
                    </div>
                    <div className="highlights-add-row">
                        <input
                            type="text" placeholder="Label (optional)" value={draftLabel}
                            onChange={e => setDraftLabel(e.target.value)}
                            className="highlights-field highlights-field--grow"
                        />
                        <button className="highlights-add-btn" onClick={handleAddHighlight}>+ Add</button>
                    </div>
                    {highlightError && <div className="highlights-error">{highlightError}</div>}

                    <div className="highlights-chip-list">
                        {timeHighlights.length === 0 && (
                            <div className="highlights-empty">No highlights yet. Add one above or drag on the chart with the tag tool.</div>
                        )}
                        {timeHighlights.map(h => (
                            <div key={h.id}>
                                <div className="highlights-chip">
                                    <input type="checkbox" checked={h.enabled} onChange={() => onToggleTimeHighlight(h.id)} title={h.enabled ? 'Hide this highlight' : 'Show this highlight'} />
                                    <ColourPicker
                                        // Keyed by chart type so a switch remounts it closed; an open popover never stays at a stale position.
                                        key={chartType}
                                        color={h.color}
                                        onChange={hex => onRecolorTimeHighlight(h.id, hex)}
                                        used={timeHighlights.filter(o => o.id !== h.id).map(o => o.color)}
                                        label={h.label}
                                        title="Highlight colour"
                                        disabled={!highlightApplies}
                                    />
                                    <div className="highlights-chip-body">
                                        {editLabelFor === h.id && highlightApplies ? (
                                            <input
                                                type="text"
                                                value={draftEditLabel}
                                                autoFocus
                                                onChange={e => setDraftEditLabel(e.target.value)}
                                                onBlur={commitEditLabel}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') commitEditLabel();
                                                    else if (e.key === 'Escape') cancelEditLabel();
                                                }}
                                                className="highlights-rename-input"
                                            />
                                        ) : (
                                            <b>{h.label}</b>
                                        )}
                                        <small>{fmtRange(h.start, h.end)}</small>
                                    </div>
                                    <button onClick={() => startEditLabel(h)} title="Rename" className="highlights-chip-icon-btn"><Pencil size={12} /></button>
                                    <button onClick={() => onRemoveTimeHighlight(h.id)} title="Remove" className="highlights-chip-icon-btn"><X size={12} /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                </fieldset>
                <div className="highlights-scope-note">
                    Applies to Line and Scatter. Line shows a tinted band over each window; Scatter rings matching points. Pair Plot keeps its own lasso-cluster gesture instead.
                </div>
            </div>

            <div className="highlights-col">
                <div className="highlights-col-head">
                    <span className="highlights-col-title">By value</span>
                    <span className="highlights-col-hint">Scatter only</span>
                </div>

                {!valueHighlightApplies && (
                    <div className="highlights-note">
                        <AlertCircle size={13} />
                        <span>Only affects <b>Scatter</b> — Line has no 3rd-sensor colour channel and Pair Plot keeps its own lasso-cluster gesture instead.</span>
                    </div>
                )}

                <fieldset disabled={!valueHighlightApplies} className={`highlights-fieldset${valueHighlightApplies ? '' : ' highlights-fieldset--dim'}`}>
                    {/* Shared single picker scoped to the chart's sensors; really disabled on Line and Pair Plot. */}
                    <SensorPickerSingle
                        sensors={valueHighlightSensors}
                        value={valueHighlight.sensor}
                        onSelect={onSetValueHighlightSensor}
                        allowNone
                        placeholder="Colour by…"
                        disabled={!valueHighlightApplies}
                        disabledReason={chartType === 'line' ? 'Colour by… (Scatter only)' : 'Colour by… (not on Pair Plot)'}
                        scope={<>Sensors on the chart · {valueHighlightSensors.length}</>}
                        ariaLabel="Colour by"
                    />

                    {valueHighlight.sensor && (
                        <>
                            <div className="highlights-chip-list">
                                {valueHighlight.ranges.length === 0 && (
                                    <div className="highlights-empty">No ranges yet — a point stays uncoloured until at least one is added below.</div>
                                )}
                                {valueHighlight.ranges.map(r => (
                                    <div key={r.id}>
                                        <div className="highlights-chip">
                                            <input type="checkbox" checked={r.enabled} onChange={() => onToggleValueHighlightRange(r.id)} title={r.enabled ? 'Hide this range' : 'Show this range'} />
                                            <ColourPicker
                                                key={chartType}
                                                color={r.color}
                                                onChange={hex => onRecolorValueHighlightRange(r.id, hex)}
                                                used={valueHighlight.ranges.filter(o => o.id !== r.id).map(o => o.color)}
                                                label={`${fmtNumExact(r.min)} – ${fmtNumExact(r.max)}${unit ? ` ${unit}` : ''}`}
                                                title="Range colour"
                                                disabled={!valueHighlightApplies}
                                            />
                                            <div className="highlights-chip-body highlights-chip-body--row">
                                                <b>{fmtNumExact(r.min)} – {fmtNumExact(r.max)}{unit && <span className="hl-unit"> {unit}</span>}</b>
                                            </div>
                                            <button onClick={() => onRemoveValueHighlightRange(r.id)} title="Remove" className="highlights-chip-icon-btn"><X size={12} /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="highlights-add-row">
                                <span className="fv-wrap highlights-fv">
                                    <input
                                        type="number" placeholder="min" value={draftRangeMin}
                                        onChange={e => { setDraftRangeMin(e.target.value); setRangeError(null); }}
                                        className={`highlights-field${unit ? ' filter-row-value--unit' : ''}`}
                                    />
                                    {unit && <span className="fv-unit" aria-hidden="true">{unit}</span>}
                                </span>
                                <span className="highlights-add-sep">–</span>
                                <span className="fv-wrap highlights-fv">
                                    <input
                                        type="number" placeholder="max" value={draftRangeMax}
                                        onChange={e => { setDraftRangeMax(e.target.value); setRangeError(null); }}
                                        className={`highlights-field${unit ? ' filter-row-value--unit' : ''}`}
                                    />
                                    {unit && <span className="fv-unit" aria-hidden="true">{unit}</span>}
                                </span>
                                <button className="highlights-add-btn" onClick={handleAddRange}>+ Add</button>
                            </div>
                            {rangeError && <div className="highlights-error">{rangeError}</div>}
                        </>
                    )}
                </fieldset>
                <div className="highlights-scope-note">
                    Applies to Scatter only. A point's colour comes from the first enabled range its value falls inside; a value matching none of them fades out instead.
                </div>
            </div>
        </div>
    );
}
