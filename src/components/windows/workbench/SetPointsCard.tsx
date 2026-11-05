import { useEffect, useState } from 'react';
import { formatSetPointText, type FieldState } from './healthChecks';

/* Number input of the Health score page's set points (used only by `ScoreRuler.tsx`). Presentational: the page keeps the DRAFT; `onChange` on every change, `onCommit` on blur / Enter. 'required'/'error' styling comes ONLY from Rust's `validation[].field`. */


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
    /** Placeholder while empty ('L'/'H', a side's sign, 'N'); 'required' is the dashed amber box and `aria-required`. */
    hint: string;
    /** The large input of the score ruler. */
    big?: boolean;
    /** Id of the element that explains this input's state (the Checks under the ruler). */
    describedBy?: string;
    /** Why the input cannot be edited right now (e.g. an export is running): disables it, as its tooltip. */
    disabledReason?: string | null;
}

/** A number input with its own text state, so "-", "1." and "" can be typed
 *  without the field fighting the parsed number. */
export function NumField({ testId, ariaLabel, unit, value, state, onChange, onCommit, suffix, wide, hint, big, describedBy, disabledReason }: NumFieldProps) {
    const [text, setText] = useState(toText(value));
    // Follow outside changes, but keep typed text that parses to the current value ('2.50' stays).
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
                disabled={!!disabledReason}
                title={disabledReason ?? undefined}
                onChange={e => { setText(e.target.value); onChange(parseNum(e.target.value)); }}
                onBlur={onCommit}
                onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
            />
            <span>{suffix ?? unit}</span>
        </span>
    );
}
