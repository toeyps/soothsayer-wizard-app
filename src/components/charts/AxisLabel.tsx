import type { CSSProperties } from 'react';
import { SensorLabel } from '../sensor/SensorLabel';
import { useSensorLookup } from '../sensor/sensorInfo';
import { NAME_TAIL_MAX, displayedName } from '../../utils/sensorNames';

/** Sensor-name axis label for Pair Plot headers/row labels: tag alone in mono with a dotted underline; hover/focus shows the stacked label (description, unit chip, tag) plus a component chip. `rotate` turns the tag -90°; never combine with ellipsis truncation. With `keyNo` the header prints 'S1' + the name's end, the row label 'S1'; PairPlotChart decides when. */
export default function AxisLabel({
    tag, rotate = false, tooltipSide = rotate ? 'right' : 'bottom', style, keyNo, keyTail,
}: {
    tag: string;
    /** The 1-based key (S1, S2 …) printed when tag headers would be cut or the set shares a start. Undefined: tag header. */
    keyNo?: number;
    /** The name's distinguishing end, printed after the key on a top header. */
    keyTail?: string;
    /** Rotate the tag text -90° (for a vertical/Y-axis label). */
    rotate?: boolean;
    /** Which side of the label the hover card opens toward. */
    tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
    /** Absolute positioning for the label itself — fully owned by the caller. */
    style: CSSProperties;
}) {
    const info = useSensorLookup()(tag);
    // Hover card only when it adds something beyond the tag; a key always has one.
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
