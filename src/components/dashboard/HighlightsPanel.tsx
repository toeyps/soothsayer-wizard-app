import { useState, useEffect } from 'react';
import { X, AlertCircle, Pencil } from 'lucide-react';
import type { TimeHighlight, ValueHighlight } from '../../types';
import ColourPicker from '../sensor/ColourPicker';
import { SensorPickerSingle } from '../sensor/SensorPicker';
import { fmtNumExact, useSensorLookup } from '../sensor/sensorInfo';

interface HighlightsPanelProps {
    // "By time" -- timestamp windows, read by Line + Scatter (not Pair Plot).
    timeHighlights: TimeHighlight[];
    onAddTimeHighlight: (start: string, end: string, label: string) => void;
    onToggleTimeHighlight: (id: string) => void;
    onRemoveTimeHighlight: (id: string) => void;
    onRecolorTimeHighlight: (id: string, color: string) => void;
    onRenameTimeHighlight: (id: string, label: string) => void;

    // "By value" -- one sensor + its value ranges, colours Scatter points.
    // Scatter-only (see ValueHighlight's own docstring in types.ts for why
    // this is a single sensor+ranges object rather than a flat list like
    // timeHighlights).
    valueHighlight: ValueHighlight;
    /** Sensors selectable in the "Colour by…" dropdown -- same pool
     *  ScatterChart itself plots (Dashboard's `scatterChartHeaders`). */
    valueHighlightSensors: string[];
    onSetValueHighlightSensor: (sensor: string) => void;
    onAddValueHighlightRange: (min: number, max: number) => void;
    onToggleValueHighlightRange: (id: string) => void;
    onRemoveValueHighlightRange: (id: string) => void;
    onRecolorValueHighlightRange: (id: string, color: string) => void;

    /** Which chart is on screen right now -- drives the live compatibility
     *  banner + disabled state below. On Pair Plot (the only chart type this
     *  group has no effect on), the "By time" column's body is fully
     *  disabled (via a wrapping <fieldset disabled>) and dims, with a
     *  banner explaining why, instead of relying on a static footnote
     *  nobody reads. Deliberately NOT just visually dimmed while staying
     *  clickable -- an earlier revision did that (reasoning: these are
     *  shared, cross-session settings someone might want to stage while
     *  looking at a different chart), but the user explicitly rejected it
     *  after seeing it live: a control that looks editable but silently
     *  does nothing on the current chart is worse than one that's plainly
     *  disabled. */
    chartType: 'line' | 'scatter' | 'pair';
}

function fmtRange(start: string, end: string): string {
    const f = (s: string) => {
        const d = new Date(s);
        if (isNaN(d.getTime())) return '?';
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    return `${f(start)} → ${f(end)}`;
}

/**
 * Dashboard's "Highlights" tab -- "By time" (timestamp-range windows, Line +
 * Scatter) and "By value" (a sensor's value ranges, Scatter only) rendered
 * SIDE BY SIDE as two columns (`.hl-grid` in the approved prototype),
 * divided by a vertical rule, instead of stacked top-to-bottom -- both are
 * visible at once without scrolling past one to reach the other. Persists
 * through Dashboard.tsx's `timeHighlights` state -- this component only owns
 * ephemeral draft-form / open-popover state, the same split already used for
 * the Selected Sensor tab's colour picker.
 */
export default function HighlightsPanel({
    timeHighlights, onAddTimeHighlight, onToggleTimeHighlight, onRemoveTimeHighlight, onRecolorTimeHighlight,
    onRenameTimeHighlight,
    valueHighlight, valueHighlightSensors, onSetValueHighlightSensor, onAddValueHighlightRange,
    onToggleValueHighlightRange, onRemoveValueHighlightRange, onRecolorValueHighlightRange,
    chartType,
}: HighlightsPanelProps) {
    const highlightApplies = chartType !== 'pair';
    // "By value" only ever does anything on Scatter -- Line has no 3rd-
    // sensor colour channel and Pair Plot keeps its own lasso-cluster.
    const valueHighlightApplies = chartType === 'scatter';

    const [draftStart, setDraftStart] = useState('');
    const [draftEnd, setDraftEnd] = useState('');
    const [draftLabel, setDraftLabel] = useState('');
    const [highlightError, setHighlightError] = useState<string | null>(null);
    // Inline label-rename -- which chip's label is currently an editable
    // text field instead of static text, plus its in-progress draft value.
    const [editLabelFor, setEditLabelFor] = useState<string | null>(null);
    const [draftEditLabel, setDraftEditLabel] = useState('');

    // "By value" draft-form state -- mirrors the "By time" block above.
    const [draftRangeMin, setDraftRangeMin] = useState('');
    const [draftRangeMax, setDraftRangeMax] = useState('');
    const [rangeError, setRangeError] = useState<string | null>(null);

    // Customer item 3: the "By value" range chips and inputs show the Colour-by sensor's unit.
    const lookup = useSensorLookup();
    const unit = valueHighlight.sensor ? lookup(valueHighlight.sensor).unit : undefined;

    // The inline rename draft is cleared on ANY chartType change: the panel's layout shifts
    // (the "Not shown on Pair Plot" banner) and a half-typed rename is cheap to restart. The
    // colour pickers (customer item 4: the shared ColourPicker) own their open state; they are
    // keyed by chart type below, so a chart switch remounts them closed the same way.
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
    // Empty labels are rejected (reverts instead of saving) -- an
    // untitled highlight chip is confusing to pick out of the list, and
    // the "+ Add" form already falls back to an auto-generated name for
    // the same reason.
    const commitEditLabel = () => {
        if (!editLabelFor) return;
        const trimmed = draftEditLabel.trim();
        if (trimmed) onRenameTimeHighlight(editLabelFor, trimmed);
        setEditLabelFor(null);
    };
    const cancelEditLabel = () => setEditLabelFor(null);

    return (
        <div className="highlights-grid">
            {/* ===== Left column: "By time" (Line + Scatter) ===== */}
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
                        <input type="datetime-local" value={draftStart} onChange={e => { setDraftStart(e.target.value); setHighlightError(null); }} className="highlights-field highlights-field--date" />
                        <span className="highlights-add-sep">→</span>
                        <input type="datetime-local" value={draftEnd} onChange={e => { setDraftEnd(e.target.value); setHighlightError(null); }} className="highlights-field highlights-field--date" />
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
                                        // Keyed by chart type: any chart switch remounts it closed, so an
                                        // open popover never survives a layout shift at a stale position.
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

            {/* ===== Right column: "By value" (Scatter only) ===== */}
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
                    {/* Customer item 3: "Colour by…" is the shared single picker, scoped to the
                        sensors on the chart — a real disabled state on Line and Pair Plot. */}
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
