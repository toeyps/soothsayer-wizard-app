import type { CSSProperties } from 'react';
import { SensorLabel } from '../sensor/SensorLabel';
import { useSensorLookup } from '../sensor/sensorInfo';
import { NAME_TAIL_MAX, displayedName } from '../../utils/sensorNames';

/**
 * Sensor-name axis label for the Pair Plot matrix (cell headers and row labels, under ~120 px).
 * DESIGN_SYSTEM §4 "Chart axes only": the tag alone in mono with a dotted underline; hovering
 * (or focusing) it shows the stacked label — description, unit chip, tag — plus a component chip.
 * Pure CSS `:hover` / `:focus-within`, no JS position tracking.
 * Zero footprint at rest: the dotted underline is the only hint.
 *
 * `rotate` rotates the tag -90° (row headers). CSS `transform` never triggers reflow, so ellipsis
 * truncation must never be combined with `rotate` (it would clip the text to a few characters
 * BEFORE rotation).
 *
 * (Scatter's axis titles have room and use the Inline label instead — see ScatterChart.)
 *
 * Rule 5 (long names): with `keyNo` the header prints "S1" + the name's end, the row label "S1"; PairPlotChart
 * decides when (a header that would be cut, or a set with a shared start) and prints the key line.
 */
export default function AxisLabel({
    tag, rotate = false, tooltipSide = rotate ? 'right' : 'bottom', style, keyNo, keyTail,
}: {
    tag: string;
    /** Rule 5: the 1-based key this sensor is printed as (S1, S2 …) when the tag headers would be cut or the
     *  set shares a start. Undefined: today's tag header. */
    keyNo?: number;
    /** Rule 5: the name's distinguishing end, printed after the key on a top header. */
    keyTail?: string;
    /** Rotate the tag text -90° (for a vertical/Y-axis label). */
    rotate?: boolean;
    /** Which side of the label the hover card opens toward. */
    tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
    /** Absolute positioning for the label itself — fully owned by the caller. */
    style: CSSProperties;
}) {
    const info = useSensorLookup()(tag);
    // A hover card only when it adds something beyond the tag shown at rest.
    // A key always has one: the card is where it reads as the sensor.
    const hoverable = !!(info.description || info.unit || info.component || keyNo);
    const tooltipStyle: CSSProperties = (() => {
        switch (tooltipSide) {
            case 'bottom': return { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 4 };
            case 'top': return { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 4 };
            case 'right': return { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 4 };
            case 'left': return { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: 4 };
        }
    })();

    return (
        <div
            style={{ position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible', zIndex: 4, ...style }}
            className={`pair-regl-axis-label${hoverable ? ' hoverable' : ''}`}
            tabIndex={hoverable ? 0 : undefined}
            // Focusable (keyboard users reach the hover card) → it needs a role for its aria-label.
            role={hoverable ? 'group' : undefined}
            aria-label={hoverable ? [info.description, info.tag, info.unit, info.component].filter(Boolean).join(' · ') : undefined}
        >
            <span
                className={keyNo ? 'pair-regl-axis-tag pair-regl-axis-tag--key' : 'pair-regl-axis-tag'}
                style={rotate ? { transform: 'rotate(-90deg)' } : { overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
                {keyNo ? <><b>S{keyNo}</b>{!rotate && <span>{keyTail || info.description || tag}</span>}</> : tag}
            </span>
            {hoverable && (
                <div className={`pair-regl-axis-tooltip pair-regl-axis-card${displayedName(info).length > NAME_TAIL_MAX ? ' pair-regl-axis-card--long' : ''}`} style={tooltipStyle}>
                    <SensorLabel
                        tag={tag}
                        info={info}
                        after={info.component ? <span className="comp-chip">{info.component}</span> : undefined}
                    />
                </div>
            )}
        </div>
    );
}
