import { useContext, useMemo, type ReactNode } from 'react';
import { SensorInline, SensorNamesContext, SensorSetContext, SensorSetProvider } from '../../sensor/SensorLabel';
import { afterPrefix } from '../../../utils/sensorNames';

/** The start both names share, once, while one of them is cut, with the names' own separator after it. */
function PairPrefix() {
    const prefix = useContext(SensorSetContext);
    const { names } = useContext(SensorNamesContext);
    if (!prefix) return null;
    const first = names.find(n => n.startsWith(prefix)) ?? '';
    const separator = first.slice(prefix.length, first.length - afterPrefix(first, prefix).length).trim();
    return <span className="wb2-pair-prefix" title={prefix}>{separator ? `${prefix} ${separator}` : prefix}</span>;
}

/** The subtitle shrinks with its content, so a shortened pair goes back by the width of the card's header line. */
const cardHeaderRoom = (root: HTMLElement) => root.closest<HTMLElement>('.wb2-card-h');

/**
 * The "X vs Y" subtitle of a Clusters card. The two names are one set (DESIGN_SYSTEM §4 rule 3): each keeps the
 * part that tells it from the other. Two names that fit print as they always did.
 */
export function PairSub({ x, y, note }: { x: string; y: string; note?: ReactNode }) {
    const tags = useMemo(() => [x, y], [x, y]);
    return (
        <span className="wb2-sub-sl" data-testid="pair-sub">
            <SensorSetProvider tags={tags} drop roomOf={cardHeaderRoom}>
                <PairPrefix />
                <SensorInline tag={x} size="sm" muted />
                <span className="wb2-pair-vs"> vs </span>
                <SensorInline tag={y} size="sm" muted />
            </SensorSetProvider>
            {note && <>{' '}<span className="wb2-sub-note">{note}</span></>}
        </span>
    );
}
