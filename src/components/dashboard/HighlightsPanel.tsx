import { useState, type CSSProperties } from 'react';
import { X, AlertCircle, Pencil } from 'lucide-react';
import type { TimeHighlight, HighlightLineDisplay, ValueHighlight } from '../../types';
import ColorPlatePicker from './ColorPlatePicker';

function fmt(n: number): string {
    if (!isFinite(n)) return '—';
    if (Math.abs(n) >= 10000 || (Math.abs(n) > 0 && Math.abs(n) < 0.01)) return n.toExponential(2);
    return n.toFixed(2);
}

interface HighlightsPanelProps {
    // "By time" -- timestamp windows, read by Line + Scatter (not Pair Plot).
    timeHighlights: TimeHighlight[];
    onAddTimeHighlight: (start: string, end: string, label: string) => void;
    onToggleTimeHighlight: (id: string) => void;
    onRemoveTimeHighlight: (id: string) => void;
    onRecolorTimeHighlight: (id: string, color: string) => void;
    onRenameTimeHighlight: (id: string, label: string) => void;

    /** How highlights render on the Line chart -- a tinted band, or by
     *  recolouring the line itself during each window. Only Line reads
     *  this: Scatter always shows the ring regardless, and Pair Plot
     *  doesn't apply at all. Both buttons are disabled outside Line (see
     *  `chartType` below), not just dimmed -- same "genuinely inert, not
     *  just dimmed" rule as the rest of this component. */
    lineDisplay: HighlightLineDisplay;
    onSetLineDisplay: (mode: HighlightLineDisplay) => void;

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
     *  group has no effect on), every input/select/button inside it is
     *  fully disabled (via a wrapping <fieldset disabled>) and dims, with a
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
 * Dashboard's "Highlights" tab -- timestamp-range windows, coloured and
 * toggled on/off, read by Line and Scatter (not Pair Plot -- it keeps its
 * own lasso-cluster gesture instead). Persists through Dashboard.tsx's
 * `timeHighlights` state -- this component only owns ephemeral draft-form /
 * open-popover state, the same split already used for the Selected Sensor
 * tab's colour picker.
 */
export default function HighlightsPanel({
    timeHighlights, onAddTimeHighlight, onToggleTimeHighlight, onRemoveTimeHighlight, onRecolorTimeHighlight,
    onRenameTimeHighlight, lineDisplay, onSetLineDisplay,
    valueHighlight, valueHighlightSensors, onSetValueHighlightSensor, onAddValueHighlightRange,
    onToggleValueHighlightRange, onRemoveValueHighlightRange, onRecolorValueHighlightRange,
    chartType,
}: HighlightsPanelProps) {
    const highlightApplies = chartType !== 'pair';
    // Band/Line-colour is a Line-only choice -- Scatter still shows
    // highlights (as a ring) but has nothing for this control to change,
    // and Pair Plot is already fully covered by `highlightApplies` above.
    const lineDisplayApplies = chartType === 'line';
    // "By value" only ever does anything on Scatter -- Line has no 3rd-
    // sensor colour channel and Pair Plot keeps its own lasso-cluster.
    const valueHighlightApplies = chartType === 'scatter';

    const [draftStart, setDraftStart] = useState('');
    const [draftEnd, setDraftEnd] = useState('');
    const [draftLabel, setDraftLabel] = useState('');
    const [highlightError, setHighlightError] = useState<string | null>(null);
    const [highlightColorFor, setHighlightColorFor] = useState<string | null>(null);
    // Inline label-rename -- which chip's label is currently an editable
    // text field instead of static text, plus its in-progress draft value.
    const [editLabelFor, setEditLabelFor] = useState<string | null>(null);
    const [draftEditLabel, setDraftEditLabel] = useState('');

    // "By value" draft-form state -- mirrors the "By time" block above.
    const [draftRangeMin, setDraftRangeMin] = useState('');
    const [draftRangeMax, setDraftRangeMax] = useState('');
    const [rangeError, setRangeError] = useState<string | null>(null);
    const [rangeColorFor, setRangeColorFor] = useState<string | null>(null);

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
        <div className="custom-scrollbar" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', padding: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>By time</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>colour Line or Scatter by a timestamp range</span>
            </div>

            {!highlightApplies && (
                <div style={compatBannerStyle}>
                    <AlertCircle size={14} style={{ flexShrink: 0, color: 'var(--warn)' }} />
                    <span style={{ flex: 1, fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        Not shown on <b style={{ color: 'var(--text-primary)' }}>Pair Plot</b> — it keeps its own lasso-cluster gesture instead.
                    </span>
                </div>
            )}

            <fieldset disabled={!highlightApplies} style={highlightApplies ? fieldsetResetStyle : { ...fieldsetResetStyle, ...mutedStyle }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                    <span style={{ fontSize: '0.68rem', fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                        Line display
                    </span>
                    <div className="chart-type-group" style={{ width: 'fit-content' }}>
                        <button
                            type="button"
                            className={`chart-type-btn${lineDisplay === 'band' ? ' active' : ''}`}
                            onClick={() => onSetLineDisplay('band')}
                            disabled={!lineDisplayApplies}
                        >
                            Band
                        </button>
                        <button
                            type="button"
                            className={`chart-type-btn${lineDisplay === 'line' ? ' active' : ''}`}
                            onClick={() => onSetLineDisplay('line')}
                            disabled={!lineDisplayApplies}
                        >
                            Line colour
                        </button>
                    </div>
                    {/* Scatter-specific: NOT the amber compatBannerStyle used
                        above -- highlights are still fully live on Scatter,
                        just fixed to the ring, so a "not shown" warning would
                        overstate it. Quiet, informational tone instead. Pair
                        Plot needs no equivalent note here -- the banner above
                        already explains the whole group is inert there. */}
                    {chartType === 'scatter' && (
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
                            Not adjustable here — Scatter always renders highlights as a ring, regardless of this setting.
                        </span>
                    )}
                </div>

                <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="datetime-local" value={draftStart} onChange={e => { setDraftStart(e.target.value); setHighlightError(null); }} style={dtInputStyle} />
                    <span style={{ color: 'var(--text-secondary)' }}>→</span>
                    <input type="datetime-local" value={draftEnd} onChange={e => { setDraftEnd(e.target.value); setHighlightError(null); }} style={dtInputStyle} />
                </div>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                    <input
                        type="text" placeholder="Label (optional)" value={draftLabel}
                        onChange={e => setDraftLabel(e.target.value)}
                        style={{ ...numInputStyle, flex: 1, width: 'auto' }}
                    />
                    <button className="text-btn" onClick={handleAddHighlight}>+ Add</button>
                </div>
                {highlightError && <div style={errorStyle}>{highlightError}</div>}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {timeHighlights.length === 0 && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', opacity: 0.6, padding: '4px 0' }}>
                            No highlights yet.
                        </div>
                    )}
                    {timeHighlights.map(h => (
                        <div key={h.id}>
                            <div style={chipRowStyle}>
                                <input type="checkbox" checked={h.enabled} onChange={() => onToggleTimeHighlight(h.id)} title={h.enabled ? 'Hide this highlight' : 'Show this highlight'} />
                                <button
                                    onClick={() => setHighlightColorFor(prev => prev === h.id ? null : h.id)}
                                    title="Change colour"
                                    style={{ ...swatchButtonStyle, background: h.color }}
                                />
                                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
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
                                            style={labelEditInputStyle}
                                        />
                                    ) : (
                                        <span style={{ fontSize: '0.78rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.label}</span>
                                    )}
                                    <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{fmtRange(h.start, h.end)}</span>
                                </div>
                                <button onClick={() => startEditLabel(h)} title="Rename" style={iconButtonStyle}><Pencil size={12} /></button>
                                <button onClick={() => onRemoveTimeHighlight(h.id)} title="Remove" style={iconButtonStyle}><X size={12} /></button>
                            </div>
                            {/* Gated on highlightApplies too, not just fieldset
                                disabled=true: ColorPlatePicker is a custom
                                drag-square/hue-slider built from plain divs, not
                                a native form control, so a disabled <fieldset>
                                alone would NOT stop it from being dragged if it
                                was already open when the chart type changed
                                underneath it. */}
                            {highlightColorFor === h.id && highlightApplies && (
                                <div style={pickerWrapStyle}>
                                    <div style={pickerBoxStyle}>
                                        <ColorPlatePicker color={h.color} onChange={hex => onRecolorTimeHighlight(h.id, hex)} />
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </fieldset>
            <div style={{ ...scopeNoteStyle, marginTop: '10px' }}>
                Applies to Line and Scatter. Line shows a tinted band or recolours itself (see above); Scatter always rings matching points. Pair Plot keeps its own lasso-cluster gesture instead.
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', margin: '16px 0 8px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>By value</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>colour Scatter points by a sensor's value range</span>
            </div>

            {!valueHighlightApplies && (
                <div style={compatBannerStyle}>
                    <AlertCircle size={14} style={{ flexShrink: 0, color: 'var(--warn)' }} />
                    <span style={{ flex: 1, fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        Only affects <b style={{ color: 'var(--text-primary)' }}>Scatter</b> — Line has no 3rd-sensor colour channel and Pair Plot keeps its own lasso-cluster gesture instead.
                    </span>
                </div>
            )}

            <fieldset disabled={!valueHighlightApplies} style={valueHighlightApplies ? fieldsetResetStyle : { ...fieldsetResetStyle, ...mutedStyle }}>
                <select
                    value={valueHighlight.sensor}
                    onChange={e => onSetValueHighlightSensor(e.target.value)}
                    style={{ ...numInputStyle, width: '100%', marginBottom: '6px' }}
                >
                    <option value="">Colour by…</option>
                    {valueHighlightSensors.map(s => <option key={s} value={s}>{s}</option>)}
                </select>

                {valueHighlight.sensor && (
                    <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                            {valueHighlight.ranges.length === 0 && (
                                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', opacity: 0.6, padding: '4px 0' }}>
                                    No ranges yet — a point stays uncoloured until at least one is added below.
                                </div>
                            )}
                            {valueHighlight.ranges.map(r => (
                                <div key={r.id}>
                                    <div style={chipRowStyle}>
                                        <input type="checkbox" checked={r.enabled} onChange={() => onToggleValueHighlightRange(r.id)} title={r.enabled ? 'Hide this range' : 'Show this range'} />
                                        <button
                                            onClick={() => setRangeColorFor(prev => prev === r.id ? null : r.id)}
                                            title="Change colour"
                                            style={{ ...swatchButtonStyle, background: r.color }}
                                        />
                                        <span style={{ flex: 1, fontSize: '0.78rem', fontWeight: 500 }}>{fmt(r.min)}–{fmt(r.max)}</span>
                                        <button onClick={() => onRemoveValueHighlightRange(r.id)} title="Remove" style={iconButtonStyle}><X size={12} /></button>
                                    </div>
                                    {/* Same reasoning as the "By time" picker above —
                                        gated on valueHighlightApplies too, not just
                                        fieldset disabled. */}
                                    {rangeColorFor === r.id && valueHighlightApplies && (
                                        <div style={pickerWrapStyle}>
                                            <div style={pickerBoxStyle}>
                                                <ColorPlatePicker color={r.color} onChange={hex => onRecolorValueHighlightRange(r.id, hex)} />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' }}>
                            <input
                                type="number" placeholder="min" value={draftRangeMin}
                                onChange={e => { setDraftRangeMin(e.target.value); setRangeError(null); }}
                                style={numInputStyle}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>–</span>
                            <input
                                type="number" placeholder="max" value={draftRangeMax}
                                onChange={e => { setDraftRangeMax(e.target.value); setRangeError(null); }}
                                style={numInputStyle}
                            />
                            <button className="text-btn" onClick={handleAddRange}>+ Add</button>
                        </div>
                        {rangeError && <div style={errorStyle}>{rangeError}</div>}
                    </>
                )}
            </fieldset>
            <div style={{ ...scopeNoteStyle, marginTop: '10px' }}>
                Applies to Scatter only. A point's colour comes from the first enabled range its value falls inside; a value matching none of them fades out instead.
            </div>
        </div>
    );
}

const numInputStyle: CSSProperties = {
    padding: '5px 6px', fontSize: '0.75rem', width: '76px',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: '5px', color: 'var(--text-primary)',
};
const dtInputStyle: CSSProperties = {
    padding: '4px 6px', fontSize: '0.72rem', flex: 1, minWidth: '150px',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: '5px', color: 'var(--text-primary)',
};
const chipRowStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 6px',
    background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '5px',
};
const labelEditInputStyle: CSSProperties = {
    fontSize: '0.78rem', fontWeight: 500, padding: '1px 4px', width: '100%',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: '4px', color: 'var(--text-primary)',
};
const swatchButtonStyle: CSSProperties = {
    width: '14px', height: '14px', borderRadius: '50%', border: '1px solid rgba(0,0,0,0.25)',
    cursor: 'pointer', flexShrink: 0, padding: 0,
};
const iconButtonStyle: CSSProperties = {
    background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer',
    padding: '2px', display: 'flex', flexShrink: 0,
};
const pickerWrapStyle: CSSProperties = {
    display: 'flex', justifyContent: 'flex-start', padding: '4px 0 8px',
};
const pickerBoxStyle: CSSProperties = {
    padding: '10px', background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: '6px', width: '160px',
};
const errorStyle: CSSProperties = {
    fontSize: '0.7rem', color: 'var(--danger, #ef4444)', marginBottom: '6px',
};
const scopeNoteStyle: CSSProperties = {
    fontSize: '0.68rem', color: 'var(--text-secondary)', opacity: 0.75,
    paddingTop: '8px', borderTop: '1px dashed var(--border)', lineHeight: 1.5,
};
const compatBannerStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 9px', marginBottom: '8px',
    background: 'var(--warn-muted)', border: '1px solid var(--warn)',
    borderRadius: '6px',
};
/** Neutralises the browser's default <fieldset> chrome (border, padding,
 *  min-width: min-content) so it behaves like the plain <div> it replaces,
 *  visually. Always applied, regardless of disabled state. */
const fieldsetResetStyle: CSSProperties = {
    border: 'none', margin: 0, padding: 0, minWidth: 0,
};
/** Dims a group's controls when they have no effect on the current chart.
 *  Paired with the group's <fieldset disabled> -- opacity alone doesn't
 *  stop clicks, so every input/select/button inside genuinely can't be
 *  used while dimmed, not just look like it shouldn't be. */
const mutedStyle: CSSProperties = {
    opacity: 0.5,
};
