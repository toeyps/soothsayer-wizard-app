import type { ReactNode } from 'react';

/*
 * KPI tiles of the Build Model Workbench ("Workbench detail pages v2", SPEC §5–§7).
 *
 * A tile is ONE number the user reads first, its unit, and a short caption under
 * it. A row of tiles (`KpiStrip`) sits above the charts of a page: on Model fit it
 * replaces the old "Statistics" table (Individual) and the stat row (Relation
 * model); the Health score page uses the same two components.
 *
 * Tiles never judge: a value is plain text, with no threshold colour and no
 * "good / weak" wording. `tone` exists only for a value that IS a health score
 * (it takes the score's own band colour) — never for a statistic.
 */

export interface KpiProps {
    label: ReactNode;
    value: ReactNode;
    /** Printed small after the value. */
    unit?: string;
    /** The caption under the value. */
    sub?: ReactNode;
    /** The band colour of a SCORE value (`ok` / `warn` / `bad`); absent = plain. */
    tone?: 'ok' | 'warn' | 'bad';
    /** A date, a word or a small graphic instead of a number: smaller type. */
    small?: boolean;
    /** Native tooltip of the whole tile. */
    title?: string;
    testId?: string;
    /** Extra content between the value and the caption (a bar, a key). */
    children?: ReactNode;
}

export function Kpi({ label, value, unit, sub, tone, small, title, testId, children }: KpiProps) {
    return (
        <div className={`wb3-kpi${tone ? ` wb3-kpi--${tone}` : ''}`} title={title} data-testid={testId}>
            <div className="wb3-kpi-l">{label}</div>
            <div className={`wb3-kpi-v${small ? ' wb3-kpi-v--sm' : ''}`}>
                {value}
                {unit && <span className="wb3-kpi-u">{unit}</span>}
            </div>
            {children}
            {sub && <div className="wb3-kpi-s">{sub}</div>}
        </div>
    );
}

/** The row of tiles; it spans every column of the board it sits in.
 *  `fit` = the Model fit strip: three equal tiles, each capped at about 420 px
 *  and kept to the left, so they do not stretch across a wide window.
 *  `scroll` = the Health score strip: ONE row of equal tiles that never wraps — on a
 *  pane too narrow for them the row scrolls sideways.
 *  `state` is printed as `data-state` (what the tiles currently show). */
export function KpiStrip({ fit, scroll, state, testId, children }: { fit?: boolean; scroll?: boolean; state?: string; testId?: string; children: ReactNode }) {
    return (
        <div className={`wb3-kpis${fit ? ' wb3-kpis--fit' : ''}${scroll ? ' wb3-kpis--scroll' : ''}`} data-testid={testId} data-state={state}>
            {children}
        </div>
    );
}
