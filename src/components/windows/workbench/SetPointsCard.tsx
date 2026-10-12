import { useEffect, useState } from 'react';
import { formatSetPointText, type FieldState } from './healthChecks';

/*
 * The number input of the Health score page's set points. The score ruler
 * (`ScoreRuler.tsx`) is its only user: the former "Health set points" table that
 * lived in this file is gone (Workbench detail pages v2).
 *
 * The user's points are the only boxes on the ruler; a box keeps the user's own
 * text while typing. Which inputs are "required" (dashed amber) / "error" (red)
 * comes ONLY from Rust's `validation[].field`; this input never decides a value
 * is wrong.
 *
 * Presentational: the page keeps the DRAFT set points; the input reports every
 * change (`onChange`) and every "done typing" (`onCommit`, on blur / Enter).
 */

// ---------------------------------------------------------------------------
// Number input
// ---------------------------------------------------------------------------

function parseNum(text: string): number | null {
    const t = text.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

const toText = (v: number | null): string => (v === null ? '' : formatSetPointText(v));

interface NumFieldProps {
    testId: string;
    /** The input's accessible name (the tick name under the band is decoration). */
    ariaLabel: string;
    unit: string;
    value: number | null;
    state: FieldState;
    onChange: (v: number | null) => void;
    onCommit: () => void;
    /** A suffix text instead of the unit (e.g. "× SD"). */
    suffix?: string;
    /** The wider box of the outer-ring field. */
    wide?: boolean;
    /** Placeholder while empty: what goes in the box, in one or two characters ("L" / "H",
     *  the side's sign for a Relation-model point, "N") — a word would not fit the box.
     *  "Required" is said by the dashed amber box and `aria-required`. */
    hint: string;
    /** The large input of the score ruler. */
    big?: boolean;
    /** Id of the element that explains this input's state (the Checks under the ruler). */
    describedBy?: string;
}

/** A number input with its own text state, so "-", "1." and "" can be typed
 *  without the field fighting the parsed number. */
export function NumField({ testId, ariaLabel, unit, value, state, onChange, onCommit, suffix, wide, hint, big, describedBy }: NumFieldProps) {
    const [text, setText] = useState(toText(value));
    // The draft changed from outside (use master, a stepper, a broadcast): follow
    // it - but never rewrite what the user is typing when it parses to the value
    // we already have ("2.50" stays "2.50").
    useEffect(() => {
        if (parseNum(text) !== value) setText(toText(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    const cls = state === 'error' ? ' hs-num--err' : state === 'required' ? ' hs-num--req' : '';
    return (
        <span className={`hs-num${wide ? ' hs-num--ring' : ''}${big ? ' hs-num--big' : ''}${cls}`}>
            <input
                id={testId}
                data-testid={testId}
                aria-label={ariaLabel}
                value={text}
                inputMode="decimal"
                placeholder={hint}
                aria-required={state === 'required' ? true : undefined}
                aria-invalid={state === 'error' ? true : undefined}
                aria-describedby={describedBy}
                onChange={e => { setText(e.target.value); onChange(parseNum(e.target.value)); }}
                onBlur={onCommit}
                onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
            />
            <span>{suffix ?? unit}</span>
        </span>
    );
}
