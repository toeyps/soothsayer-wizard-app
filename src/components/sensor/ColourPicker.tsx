import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import { usePopoverDismiss } from './SensorPicker';
import ColorPlatePicker from '../dashboard/ColorPlatePicker';

/** The one colour picker: 12 palette swatches plus a custom colour (`ColorPlatePicker`); picks apply at once, Esc closes. */

/** Palette swatches, in the order multiple sensors take them. */
export const COLOUR_PALETTE = [
    '#3b82f6', '#10b981', '#f43f5e', '#8b5cf6', '#06b6d4', '#84cc16',
    '#d946ef', '#f97316', '#f59e0b', '#14b8a6', '#6366f1', '#ec4899',
] as const;

/** What a swatch is called in its tooltip / accessible name — same order as `COLOUR_PALETTE`. */
export const COLOUR_NAMES = [
    'Blue', 'Green', 'Red', 'Violet', 'Cyan', 'Lime',
    'Magenta', 'Orange', 'Amber', 'Teal', 'Indigo', 'Pink',
] as const;

/** '#rrggbb' (lower case) from a stored colour, with or without '#' and spaces; null unless exactly 6 hex digits. */
export function parseHexColour(text: string): string | null {
    const t = text.trim().replace(/^#/, '');
    return /^[0-9a-f]{6}$/i.test(t) ? `#${t.toLowerCase()}` : null;
}

const norm = (c: string) => c.trim().toLowerCase();

export interface ColourPickerProps {
    /** Current colour, '#rrggbb'. */
    color: string;
    onChange: (hex: string) => void;
    /** Colours other items on the same chart already use (they get a dot). */
    used?: string[];
    /** Popover heading and accessible name, e.g. the sensor's description or "Range 2". */
    label?: string;
    /** Button tooltip / accessible name, e.g. "Line colour". */
    title?: string;
    disabled?: boolean;
    /** Called when the popover opens (e.g. to close a neighbouring popover). */
    onOpen?: () => void;
}

export default function ColourPicker({ color, onChange, used = [], label, title = 'Colour', disabled, onOpen }: ColourPickerProps) {
    const [rect, setRect] = useState<PopoverAnchorRect | null>(null);
    const [custom, setCustom] = useState(false);
    const btn = useRef<HTMLButtonElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const current = parseHexColour(color) ?? color;
    const inPalette = COLOUR_PALETTE.some(p => p === norm(current));

    // Disabled while open (e.g. the chart type changed under it) → close, don't keep a live picker.
    useEffect(() => { if (disabled) setRect(null); }, [disabled]);

    const open = () => {
        if (disabled || !btn.current) return;
        const r = btn.current.getBoundingClientRect();
        setCustom(!inPalette);
        setRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        onOpen?.();
    };
    const close = useCallback((focus = true) => {
        setRect(null);
        if (focus) requestAnimationFrame(() => btn.current?.focus());
    }, []);

    usePopoverDismiss(!!rect, btn, 'cp-pop', close);

    const usedSet = new Set(used.map(norm));
    const anyUsed = COLOUR_PALETTE.some(p => p !== norm(current) && usedSet.has(p));

    const onGridKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
        const move = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 } as Record<string, number>)[e.key];
        if (move === undefined) return;
        e.preventDefault();
        const n = Math.max(0, Math.min(COLOUR_PALETTE.length - 1, i + move));
        (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
    };
    const onPopKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (e.key === 'Tab') {
            // Tab out of either end closes: past the last control, or Shift+Tab from the palette back to the swatch button.
            const f = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([tabindex="-1"])')];
            const at = document.activeElement as HTMLElement | null;
            const first = e.shiftKey && (at === f[0] || (!!at && !!gridRef.current?.contains(at)));
            if (first || (!e.shiftKey && at === f[f.length - 1])) { e.preventDefault(); close(); }
        }
    };

    return (
        <>
            <button
                ref={btn}
                type="button"
                className="cp-hit"
                title={title}
                aria-label={label ? `${title}: ${label}` : title}
                aria-haspopup="dialog"
                aria-expanded={!!rect}
                disabled={disabled}
                onClick={(e) => { e.stopPropagation(); if (rect) close(); else open(); }}
            >
                <span className="cp-swatch" style={{ background: current }} />
            </button>
            {rect && (
                <AnchoredPopover
                    anchorRect={rect}
                    onRequestClose={() => close(false)}
                    // Not `autoFocus`: WebView2's focus-scroll could dismiss the popover; focus the current swatch once placed.
                    onPlaced={() => gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true })}
                    style={{ width: 228, padding: 0, maxHeight: 'none', overflow: 'visible' }}
                >
                    <div className="cp-pop" role="dialog" aria-label={`Colour${label ? ` for ${label}` : ''}`} onKeyDown={onPopKey}>
                        <div className="cp-head">
                            <span className="cp-head-label">{label ?? 'Colour'}</span>
                        </div>
                        <div className="cp-grid" role="radiogroup" aria-label="Palette" ref={gridRef}>
                            {COLOUR_PALETTE.map((p, i) => {
                                const sel = p === norm(current);
                                const inUse = !sel && usedSet.has(p);
                                const name = COLOUR_NAMES[i];
                                return (
                                    <button
                                        key={p}
                                        type="button"
                                        role="radio"
                                        aria-checked={sel}
                                        aria-label={`${name}${inUse ? ', in use on this chart' : ''}`}
                                        tabIndex={sel || (i === 0 && !inPalette) ? 0 : -1}
                                        className={`cp-sw${sel ? ' sel' : ''}`}
                                        style={{ background: p }}
                                        data-colour={p}
                                        title={`${name}${inUse ? ' · in use on this chart' : ''}`}
                                        onKeyDown={e => onGridKey(e, i)}
                                        onClick={() => onChange(p)}
                                    >
                                        {sel && <span className="cp-chk"><Check size={12} strokeWidth={3} /></span>}
                                        {inUse && <span className="cp-used" />}
                                    </button>
                                );
                            })}
                        </div>
                        {anyUsed && <div className="cp-legend"><i aria-hidden="true" />In use on this chart</div>}
                        <button type="button" className="cp-custom" aria-expanded={custom} onClick={() => setCustom(c => !c)}>
                            <span>Custom colour</span><ChevronRight size={12} className="cp-car" aria-hidden="true" />
                        </button>
                        {custom && (
                            <div className="cp-adv">
                                <ColorPlatePicker color={parseHexColour(color) ?? '#3b82f6'} onChange={onChange} />
                            </div>
                        )}
                    </div>
                </AnchoredPopover>
            )}
        </>
    );
}
