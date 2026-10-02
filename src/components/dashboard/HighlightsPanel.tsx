import { useState, useEffect } from 'react';
import { X, AlertCircle, Pencil } from 'lucide-react';
import type { TimeHighlight, HighlightLineDisplay, ValueHighlight } from '../../types';
import ColorPlatePicker from './ColorPlatePicker';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';

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
    // Viewport-relative rect of the swatch button that opened the colour
    // picker — visual-refresh-only (see AnchoredPopover's docstring): the
    // picker now renders through a floating popover instead of expanding
    // inline within this scrolling panel.
    const [highlightColorAnchor, setHighlightColorAnchor] = useState<PopoverAnchorRect | null>(null);
    // Inline label-rename -- which chip's label is currently an editable
    // text field instead of static text, plus its in-progress draft value.
    const [editLabelFor, setEditLabelFor] = useState<string | null>(null);
    const [draftEditLabel, setDraftEditLabel] = useState('');

    // "By value" draft-form state -- mirrors the "By time" block above.
    const [draftRangeMin, setDraftRangeMin] = useState('');
    const [draftRangeMax, setDraftRangeMax] = useState('');
    const [rangeError, setRangeError] = useState<string | null>(null);
    const [rangeColorFor, setRangeColorFor] = useState<string | null>(null);
    // Same idea as `highlightColorAnchor` above, for the "By value" range
    // colour popover.
    const [rangeColorAnchor, setRangeColorAnchor] = useState<PopoverAnchorRect | null>(null);

    // Both colour popovers (and the inline rename draft) are gated on
    // `highlightApplies`/`valueHighlightApplies` (see their render sites
    // below) rather than unmounted along with their row, so switching chart
    // type away and back doesn't naturally clear `highlightColorFor`/
    // `rangeColorFor`/`editLabelFor` the way a removed row would. A round
    // trip like Line -> Pair Plot -> Line left the picker re-mounting
    // unasked at the screen position captured before the switch -- the
    // panel's own layout shifts in between (the "Not shown on Pair Plot"
    // banner appears above the list), so that position is stale.
    //
    // Narrowing this to "only clear when the column becomes DISABLED" (the
    // original fix) missed a second case: Line <-> Scatter never disables
    // the "By time" column, but Scatter inserts/removes its own inline note
    // above the chip list, which also moves the swatch -- so the popover
    // stayed open at a stale position across that switch too. Clearing on
    // ANY chartType change (not just disabled transitions) covers both --
    // every popover/draft that depends on chart-relative layout is cheap to
    // re-open, so there's no reason to try to preserve it across a type
    // switch (QA sweep, 2026-10-02).
    useEffect(() => {
        setHighlightColorFor(null);
        setHighlightColorAnchor(null);
        setRangeColorFor(null);
        setRangeColorAnchor(null);
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
                    <span className="highlights-spacer" />
                    <div className="highlights-seg" title="How highlights render on the Line chart">
                        <button
                            type="button"
                            className={lineDisplay === 'band' ? 'is-on' : ''}
                            onClick={() => onSetLineDisplay('band')}
                            disabled={!lineDisplayApplies}
                        >
                            Band
                        </button>
                        <button
                            type="button"
                            className={lineDisplay === 'line' ? 'is-on' : ''}
                            onClick={() => onSetLineDisplay('line')}
                            disabled={!lineDisplayApplies}
                        >
                            Line colour
                        </button>
                    </div>
                </div>

                {!highlightApplies && (
                    <div className="highlights-note">
                        <AlertCircle size={13} />
                        <span>Not shown on <b>Pair Plot</b> — it uses its own lasso clusters.</span>
                    </div>
                )}

                <fieldset disabled={!highlightApplies} className={`highlights-fieldset${highlightApplies ? '' : ' highlights-fieldset--dim'}`}>
                    {/* Scatter-specific: NOT the amber note above -- highlights
                        are still fully live on Scatter, just fixed to the
                        ring, so a "not shown" warning would overstate it.
                        Quiet, informational tone instead. Pair Plot needs no
                        equivalent note here -- the banner above already
                        explains the whole column is inert there. */}
                    {chartType === 'scatter' && (
                        <div className="highlights-inline-note">
                            Not adjustable here — Scatter always renders highlights as a ring, regardless of this setting.
                        </div>
                    )}

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
                                    <button
                                        onClick={(e) => {
                                            const opening = highlightColorFor !== h.id;
                                            setHighlightColorFor(opening ? h.id : null);
                                            setHighlightColorAnchor(opening ? e.currentTarget.getBoundingClientRect() : null);
                                        }}
                                        title="Change colour"
                                        className="highlights-chip-swatch"
                                        style={{ background: h.color }}
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
                                {/* Gated on highlightApplies too, not just fieldset
                                    disabled=true: ColorPlatePicker is a custom
                                    drag-square/hue-slider built from plain divs, not
                                    a native form control, so a disabled <fieldset>
                                    alone would NOT stop it from being dragged if it
                                    was already open when the chart type changed
                                    underneath it. */}
                                {highlightColorFor === h.id && highlightApplies && (
                                    <AnchoredPopover
                                        anchorRect={highlightColorAnchor}
                                        onRequestClose={() => { setHighlightColorFor(null); setHighlightColorAnchor(null); }}
                                        style={{ width: 160 }}
                                    >
                                        <ColorPlatePicker color={h.color} onChange={hex => onRecolorTimeHighlight(h.id, hex)} />
                                    </AnchoredPopover>
                                )}
                            </div>
                        ))}
                    </div>
                </fieldset>
                <div className="highlights-scope-note">
                    Applies to Line and Scatter. Line shows a tinted band or recolours itself (see above); Scatter always rings matching points. Pair Plot keeps its own lasso-cluster gesture instead.
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
                    <select
                        value={valueHighlight.sensor}
                        onChange={e => onSetValueHighlightSensor(e.target.value)}
                        className="highlights-field highlights-field--full"
                    >
                        <option value="">Colour by…</option>
                        {valueHighlightSensors.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

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
                                            <button
                                                onClick={(e) => {
                                                    const opening = rangeColorFor !== r.id;
                                                    setRangeColorFor(opening ? r.id : null);
                                                    setRangeColorAnchor(opening ? e.currentTarget.getBoundingClientRect() : null);
                                                }}
                                                title="Change colour"
                                                className="highlights-chip-swatch"
                                                style={{ background: r.color }}
                                            />
                                            <div className="highlights-chip-body highlights-chip-body--row">
                                                <b>{fmt(r.min)} – {fmt(r.max)}</b>
                                            </div>
                                            <button onClick={() => onRemoveValueHighlightRange(r.id)} title="Remove" className="highlights-chip-icon-btn"><X size={12} /></button>
                                        </div>
                                        {/* Same reasoning as the "By time" picker above —
                                            gated on valueHighlightApplies too, not just
                                            fieldset disabled. */}
                                        {rangeColorFor === r.id && valueHighlightApplies && (
                                            <AnchoredPopover
                                                anchorRect={rangeColorAnchor}
                                                onRequestClose={() => { setRangeColorFor(null); setRangeColorAnchor(null); }}
                                                style={{ width: 160 }}
                                            >
                                                <ColorPlatePicker color={r.color} onChange={hex => onRecolorValueHighlightRange(r.id, hex)} />
                                            </AnchoredPopover>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className="highlights-add-row">
                                <input
                                    type="number" placeholder="min" value={draftRangeMin}
                                    onChange={e => { setDraftRangeMin(e.target.value); setRangeError(null); }}
                                    className="highlights-field"
                                />
                                <span className="highlights-add-sep">–</span>
                                <input
                                    type="number" placeholder="max" value={draftRangeMax}
                                    onChange={e => { setDraftRangeMax(e.target.value); setRangeError(null); }}
                                    className="highlights-field"
                                />
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
