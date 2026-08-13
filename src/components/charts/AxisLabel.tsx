import type { CSSProperties } from 'react';

/**
 * Sensor-name axis label with an on-hover tooltip showing the sensor's full
 * description (when known from the mapping CSV). Pure CSS `:hover` — no JS
 * hover-state or position tracking — so it works the same wherever it's
 * placed. Deliberately zero footprint at rest (approved design over an
 * always-visible legend): the dotted underline is the only hint, the
 * tooltip itself takes no layout space until hovered.
 *
 * Shared between PairPlotChart (small per-cell labels, rotated for row
 * headers) and ScatterChart (X/Y axis titles) — each caller supplies its
 * own `style` for where the label sits, since the two charts' padding/frame
 * geometry differs. `rotate` controls whether the tag text is rotated -90°
 * (row/Y-axis headers) — CSS `transform` never triggers reflow, so ellipsis
 * truncation must never be combined with `rotate` (would clip the text to a
 * few characters BEFORE rotation — a regression this component already
 * fixed once for PairPlotChart's row headers).
 */
export default function AxisLabel({
    tag, description, rotate = false, tooltipSide = rotate ? 'right' : 'bottom', style,
}: {
    tag: string;
    description?: string;
    /** Rotate the tag text -90° (for a vertical/Y-axis label). */
    rotate?: boolean;
    /** Which side of the label the tooltip bubble opens toward. */
    tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
    /** Absolute positioning for the label itself — fully owned by the caller. */
    style: CSSProperties;
}) {
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
            className={`pair-regl-axis-label${description ? ' hoverable' : ''}`}
        >
            <span style={{
                fontSize: 10, color: 'var(--text-primary)', fontFamily: 'Inter, system-ui',
                whiteSpace: 'nowrap',
                // Ellipsis is safe (and wanted) for non-rotated text — it just
                // truncates gracefully in the horizontal space it actually
                // has. It must NOT apply when rotated — see the docstring above.
                ...(rotate ? { transform: 'rotate(-90deg)' } : { overflow: 'hidden', textOverflow: 'ellipsis' }),
            }}>
                {tag}
            </span>
            {description && (
                <div className="pair-regl-axis-tooltip" style={tooltipStyle}>
                    <div className="pair-regl-axis-tooltip-tag">{tag}</div>
                    <div className="pair-regl-axis-tooltip-desc">{description}</div>
                </div>
            )}
        </div>
    );
}
