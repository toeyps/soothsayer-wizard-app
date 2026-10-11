import type { CSSProperties, ReactNode } from 'react';
import type { SensorMetadata, SpecialSensorRecipe } from '../../types';
import { SensorMetaContext, sensorTitle, useLayeredSensorLookup, useSensorLookup, type SensorInfo } from './sensorInfo';

/**
 * The ONE sensor label (DESIGN_SYSTEM §4 "Sensor label — ONE standard"):
 * description first, tag second, in two variants of one component.
 *  - `SensorLabel` (Stacked): lists, cards, headers — line 1 description + unit chip, line 2 tag.
 *  - `SensorInline` (Inline): picker triggers/rows, chips, condition rows, chart subtitles,
 *    tooltips — description then tag on one line, no brackets.
 * No description → the tag alone, in mono, on line 1 (never a "no description" placeholder,
 * never the tag twice). Every label carries `title` = "DESCRIPTION · TAG · UNIT · Component".
 */

/** Supplies sensor metadata to every label / picker below it. Nested providers inherit what
 *  they are not given (own metadata wins per tag; `special` badges are inherited unless given). */
export function SensorMetaProvider({ metadata, special, children }: {
    metadata?: SensorMetadata[] | null;
    special?: Pick<SpecialSensorRecipe, 'tag' | 'kind'>[] | null;
    children: ReactNode;
}) {
    const lookup = useLayeredSensorLookup(metadata, special);
    return <SensorMetaContext.Provider value={lookup}>{children}</SensorMetaContext.Provider>;
}

function FxBadge({ special }: { special?: 'f' | 's' }) {
    if (!special) return null;
    return <span className={`sl-fx sl-fx--${special}`} aria-hidden="true">{special === 'f' ? 'ƒ' : 'Σ'}</span>;
}

interface LabelProps {
    tag: string;
    /** Explicit metadata (wins over the provider). */
    info?: SensorInfo;
    /** Stacked only: show the unit chip (default true). Inline never shows the unit. */
    unit?: boolean;
    /** 'lg' = Workbench detail header, 'sm' = chips / chart subtitles. */
    size?: 'sm' | 'md' | 'lg';
    /** Muted colours (chart subtitles). */
    muted?: boolean;
    /** Inline only: trigger / row context — the tag hides below ~150 px of label width. */
    fit?: boolean;
    className?: string;
    style?: CSSProperties;
    /** Stacked only: extra element after the tag on line 2 (e.g. a component chip). */
    after?: ReactNode;
}

/** 'md' is the base look (no modifier class). */
const sizeClass = (size: 'sm' | 'md' | 'lg', muted?: boolean) =>
    [size === 'md' ? '' : `sl--${size}`, muted ? 'sl--muted' : ''].filter(Boolean).join(' ');

/** Stacked label. */
export function SensorLabel({ tag, info, unit = true, size = 'md', muted, className = '', style, after }: LabelProps) {
    const lookup = useSensorLookup();
    const i = info ?? lookup(tag);
    return (
        <span
            className={['sl', sizeClass(size, muted), i.description ? '' : 'sl--notag', className].filter(Boolean).join(' ')}
            title={sensorTitle(i)}
            style={style}
        >
            <span className="sl-l1">
                <FxBadge special={i.special} />
                <span className="sl-desc">{i.description || i.tag}</span>
                {unit && i.unit && <span className="unit-badge sl-unit">{i.unit}</span>}
            </span>
            {(i.description || after) && (
                <span className="sl-l2">
                    {i.description && <span className="sl-tag">{i.tag}</span>}
                    {after}
                </span>
            )}
        </span>
    );
}

/** Inline label. */
export function SensorInline({ tag, info, size = 'md', muted, fit, className = '', style }: LabelProps) {
    const lookup = useSensorLookup();
    const i = info ?? lookup(tag);
    return (
        <span
            className={`sl-inline-wrap${fit ? ' sl-fit' : ''}${className ? ` ${className}` : ''}`}
            title={sensorTitle(i)}
            style={style}
        >
            <span className={['sl-inline', sizeClass(size, muted), i.description ? '' : 'sl--notag'].filter(Boolean).join(' ')}>
                <FxBadge special={i.special} />
                <span className="sl-desc">{i.description || i.tag}</span>
                {i.description && <span className="sl-tag">{i.tag}</span>}
            </span>
        </span>
    );
}
