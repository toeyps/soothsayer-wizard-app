import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { STIFFNESS_DEFAULT, STIFFNESS_OPTIONS } from '../../reports/pmReportTypes';

/** What each step does, in one plain line (same order as STIFFNESS_OPTIONS). */
export const STEP_HINT = [
    'Follows every bump in the data — closest fit, least smooth.',
    'Follows most bumps in the data.',
    'Follows the data a little more than Standard.',
    'Balanced between following the data and staying smooth.',
    'A little smoother than Standard.',
    'Smooth — ignores most short bumps.',
    'Smoothest — close to a straight trend.',
];

/** A small fitted curve: step 0 = wiggly (follows the noise), step 6 = smooth. */
export function CurveGlyph({ i, w = 22, h = 12 }: { i: number; w?: number; h?: number }) {
    const n = 24;
    const amp = [1, 0.78, 0.58, 0.4, 0.24, 0.12, 0.03][i] ?? 0.4;
    const pts: string[] = [];
    for (let k = 0; k <= n; k++) {
        const x = k / n;
        const trend = 0.62 - 0.3 * Math.sin(x * Math.PI * 0.9);
        const wig = Math.sin(x * 23) * 0.55 + Math.sin(x * 41 + 1) * 0.3 + Math.sin(x * 9 + 2) * 0.15;
        const y = trend + wig * 0.22 * amp;
        pts.push(`${(1 + x * (w - 2)).toFixed(1)},${(1 + Math.min(1, Math.max(0, y)) * (h - 2)).toFixed(1)}`);
    }
    return (
        <svg className="stf-glyph" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

const N = STIFFNESS_OPTIONS.length;
const DEFAULT_IDX = STIFFNESS_OPTIONS.findIndex(o => o.value === STIFFNESS_DEFAULT);
const idxOf = (v: number) => Math.max(0, STIFFNESS_OPTIONS.findIndex(o => o.value === v));

/** Relation model "Stiffness": a select button with the step's curve; the list shows every step's curve. */
export function StiffnessField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const labelId = useId();
    const i = idxOf(value);
    const [open, setOpen] = useState(false);
    const [hi, setHi] = useState(i);
    const box = useRef<HTMLDivElement>(null);
    const btn = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
        window.addEventListener('mousedown', off);
        return () => window.removeEventListener('mousedown', off);
    }, [open]);

    const set = (k: number) => { if (k !== i) onChange(STIFFNESS_OPTIONS[k].value); };
    const pick = (k: number) => { set(k); setOpen(false); btn.current?.focus(); };
    const onKey = (e: KeyboardEvent) => {
        if (!open) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHi(i); setOpen(true); return; }
            const n = e.key === 'ArrowRight' ? Math.min(N - 1, i + 1)
                : e.key === 'ArrowLeft' ? Math.max(0, i - 1)
                : e.key === 'Home' ? 0 : e.key === 'End' ? N - 1 : null;
            if (n !== null) { e.preventDefault(); set(n); }
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(hi); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(N - 1, h + 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
        if (e.key === 'Tab') setOpen(false);
    };

    return (
        <div className="f4-fld stf">
            <span className="f4-lbl" id={labelId}>Stiffness</span>
            <div className="stf-b" ref={box}>
                <button
                    ref={btn}
                    type="button"
                    className={`stf-b-btn${open ? ' open' : ''}`}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-labelledby={labelId}
                    data-testid="stiffness-select"
                    onClick={() => { setHi(i); setOpen(o => !o); }}
                    onKeyDown={onKey}
                >
                    <CurveGlyph i={i} w={26} h={14} />
                    <span className="stf-b-t">{STIFFNESS_OPTIONS[i].label}</span>
                    <ChevronDown size={13} aria-hidden="true" />
                </button>
                {open && (
                    <div className="stf-b-pop" role="listbox" aria-labelledby={labelId}>
                        <div className="stf-b-cap" aria-hidden="true"><span>Follows the data</span><span>Smooth</span></div>
                        {STIFFNESS_OPTIONS.map((o, k) => (
                            <div
                                key={o.value}
                                role="option"
                                aria-selected={k === i}
                                className={`stf-b-row${k === hi ? ' hi' : ''}${k === i ? ' sel' : ''}`}
                                onMouseEnter={() => setHi(k)}
                                onMouseDown={e => { e.preventDefault(); pick(k); }}
                            >
                                <CurveGlyph i={k} w={40} h={16} />
                                <span className="stf-b-rt">{o.label}{k === DEFAULT_IDX && <i> · default</i>}</span>
                                {k === i && <Check size={13} aria-hidden="true" />}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="f4-hint">{STEP_HINT[i]}</div>
        </div>
    );
}
