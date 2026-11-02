import { useContext, useMemo, type ReactNode } from 'react';
import { SensorInline, SensorSetContext, SensorSetProvider } from '../../sensor/SensorLabel';

/** The start both names share, once, while one of them is cut. */
function PairPrefix() {
    const prefix = useContext(SensorSetContext);
    return prefix ? <span className="wb2-pair-prefix" title={prefix}>{prefix} -</span> : null;
}

/**
 * The "X vs Y" subtitle of a Clusters card. The two names are one set (DESIGN_SYSTEM §4 rule 3): each keeps the
 * part that tells it from the other. Two names that fit print as they always did.
 */
export function PairSub({ x, y, note }: { x: string; y: string; note?: ReactNode }) {
    const tags = useMemo(() => [x, y], [x, y]);
    return (
        <span className="wb2-sub-sl" data-testid="pair-sub">
            <SensorSetProvider tags={tags} drop>
                <PairPrefix />
                <SensorInline tag={x} size="sm" muted />
                <span className="wb2-pair-vs"> vs </span>
                <SensorInline tag={y} size="sm" muted />
            </SensorSetProvider>
            {note && <>{' '}<span className="wb2-sub-note">{note}</span></>}
        </span>
    );
}
