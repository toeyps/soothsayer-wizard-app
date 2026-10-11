import type { CSSProperties } from 'react';
import { SensorLabel } from '../sensor/SensorLabel';
import { useSensorLookup } from '../sensor/sensorInfo';

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
 */
export default function AxisLabel({
    tag, rotate = false, tooltipSide = rotate ? 'right' : 'bottom', style,
}: {
    tag: string;
    /** Rotate the tag text -90° (for a vertical/Y-axis label). */
    rotate?: boolean;
    /** Which side of the label the hover card opens toward. */
    tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
    /** Absolute positioning for the label itself — fully owned by the caller. */
    style: CSSProperties;
}) {
    const info = useSensorLookup()(tag);
    // A hover card only when it adds something beyond the tag shown at rest.
    const hoverable = !!(info.description || info.unit || info.component);
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
                className="pair-regl-axis-tag"
                style={rotate ? { transform: 'rotate(-90deg)' } : { overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
                {tag}
            </span>
            {hoverable && (
                <div className="pair-regl-axis-tooltip pair-regl-axis-card" style={tooltipStyle}>
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
