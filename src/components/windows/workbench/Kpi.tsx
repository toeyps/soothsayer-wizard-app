import type { ReactNode } from 'react';

/* KPI tiles of the Build Model Workbench: one number, its unit and a short caption; `KpiStrip` is a row of them. Tiles never judge: `tone` exists only for a value that IS a health score (its own band colour). */

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

/** Row of tiles spanning every column. `fit` = Model fit strip: three equal tiles capped at ~420 px, kept left. `scroll` = Health score strip: one non-wrapping row that scrolls sideways when narrow. */
export function KpiStrip({ fit, scroll, state, testId, children }: { fit?: boolean; scroll?: boolean; state?: string; testId?: string; children: ReactNode }) {
    return (
        <div className={`wb3-kpis${fit ? ' wb3-kpis--fit' : ''}${scroll ? ' wb3-kpis--scroll' : ''}`} data-testid={testId} data-state={state}>
            {children}
        </div>
    );
}
