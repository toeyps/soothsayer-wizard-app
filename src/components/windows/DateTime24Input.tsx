import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Calendar, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import { clampDateTime, formatDateTime24, monthCells, parseDateTime24 } from '../../utils/dateTime24';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const POP_WIDTH = 252;

const pad = (n: number) => String(n).padStart(2, '0');

interface DateTime24InputProps {
    ariaLabel: string;
    invalid?: boolean;
    /** `YYYY-MM-DDTHH:mm`, `''` when empty. */
    value: string;
    min?: string;
    max?: string;
    /** Same as a `datetime-local`: the value when complete, `''` while it is not. */
    onChange: (value: string) => void;
    onCommit?: () => void;
    /** The field was left blank (a field whose owner shows a default when it has no value). */
    onClear?: () => void;
    /** The calendar button's own look and name, where the field is not inside `.f4-dtw`. */
    calClassName?: string;
    calLabel?: string;
    /** Placed between the text and the calendar button. */
    children?: ReactNode;
}

/** Always-24-hour date+time field: text plus a calendar button, for inside `.f4-dtw` or another shell. Typed text stays while incomplete, like a `datetime-local`. */
export function DateTime24Input({ ariaLabel, invalid, value, min, max, onChange, onCommit, onClear, calClassName = 'f4-dtw-cal', calLabel = 'Open date picker', children }: DateTime24InputProps) {
    const [text, setText] = useState(() => formatDateTime24(value));
    const reported = useRef(value);
    const [rect, setRect] = useState<PopoverAnchorRect | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (value === reported.current) return;
        reported.current = value;
        setText(formatDateTime24(value));
    }, [value]);

    const report = (next: string) => {
        reported.current = next;
        onChange(next);
    };

    const closePicker = () => {
        setRect(null);
        onCommit?.();
        buttonRef.current?.focus({ preventScroll: true });
    };

    return (
        <>
            <input
                type="text"
                aria-label={ariaLabel}
                aria-invalid={invalid || undefined}
                placeholder="YYYY/MM/DD HH:mm"
                spellCheck={false}
                value={text}
                onChange={e => {
                    setText(e.target.value);
                    report(parseDateTime24(e.target.value));
                }}
                onBlur={() => {
                    onCommit?.();
                    setText(formatDateTime24(parseDateTime24(text) || value));
                    if (!text.trim()) onClear?.();
                }}
                onKeyDown={e => { if (e.key === 'Enter') onCommit?.(); }}
            />
            {children}
            <button
                ref={buttonRef}
                type="button"
                className={calClassName}
                aria-label={calLabel}
                title={calLabel}
                aria-expanded={!!rect}
                onClick={e => {
                    if (rect) closePicker();
                    else setRect((e.currentTarget.closest('.f4-dtw') ?? e.currentTarget).getBoundingClientRect());
                }}
            >
                <Calendar size={14} />
            </button>
            {rect && (
                <AnchoredPopover anchorRect={rect} onRequestClose={() => { setRect(null); onCommit?.(); }} width={POP_WIDTH}>
                    <CalendarPanel
                        label={ariaLabel}
                        value={value}
                        min={min}
                        max={max}
                        anchor={buttonRef}
                        onPick={next => {
                            report(next);
                            setText(formatDateTime24(next));
                        }}
                        onClose={closePicker}
                    />
                </AnchoredPopover>
            )}
        </>
    );
}

function CalendarPanel({ label, value, min, max, anchor, onPick, onClose }: {
    label: string;
    value: string;
    min?: string;
    max?: string;
    anchor: RefObject<HTMLButtonElement | null>;
    onPick: (value: string) => void;
    onClose: () => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const start = value || min || max || '';
    const today = new Date();
    const [view, setView] = useState(() => (
        /^\d{4}-\d{2}/.test(start)
            ? { year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) - 1 }
            : { year: today.getFullYear(), month: today.getMonth() }
    ));
    const [hour, setHour] = useState(value.slice(11, 13) || '00');
    const [minute, setMinute] = useState(value.slice(14, 16) || '00');
    const date = value.slice(0, 10);

    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!panelRef.current?.contains(target) && !anchor.current?.contains(target)) closeRef.current();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [anchor]);

    const put = (day: string, h: string, m: string) => {
        onPick(clampDateTime(`${day}T${pad(Number(h))}:${pad(Number(m))}`, min, max));
    };

    const typeTime = (raw: string, limit: number, set: (v: string) => void, apply: (v: string) => void) => {
        const digits = raw.replace(/\D/g, '').slice(0, 2);
        set(digits);
        if (digits !== '' && Number(digits) <= limit && date) apply(digits);
    };
    const settleTime = (current: string, limit: number, set: (v: string) => void) => {
        set(current !== '' && Number(current) <= limit ? pad(Number(current)) : '00');
    };

    const shift = (months: number) => setView(v => {
        const d = new Date(v.year, v.month + months, 1);
        return { year: d.getFullYear(), month: d.getMonth() };
    });

    const minDay = min?.slice(0, 10);
    const maxDay = max?.slice(0, 10);
    const inMonth = `${view.year}-${pad(view.month + 1)}`;

    return (
        <div ref={panelRef} className="dt24-pop" role="dialog" aria-label={`${label}: pick a date and time`} data-testid="dt24-pop">
            <div className="dt24-head">
                <button type="button" aria-label="Previous year" onClick={() => shift(-12)}><ChevronsLeft size={14} /></button>
                <button type="button" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={14} /></button>
                <b data-testid="dt24-month">{MONTHS[view.month]} {view.year}</b>
                <button type="button" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={14} /></button>
                <button type="button" aria-label="Next year" onClick={() => shift(12)}><ChevronsRight size={14} /></button>
            </div>
            <div className="dt24-grid">
                {WEEKDAYS.map(d => <span key={d} className="dt24-wd">{d}</span>)}
                {monthCells(view.year, view.month).map(day => (
                    <button
                        key={day}
                        type="button"
                        className={`dt24-day${day.startsWith(inMonth) ? '' : ' dt24-day--out'}${day === date ? ' dt24-day--on' : ''}`}
                        aria-label={day}
                        aria-pressed={day === date}
                        disabled={(!!minDay && day < minDay) || (!!maxDay && day > maxDay)}
                        onClick={() => put(day, hour || '0', minute || '0')}
                    >
                        {Number(day.slice(8))}
                    </button>
                ))}
            </div>
            <div className="dt24-time">
                <span>Time</span>
                <input
                    aria-label="Hour, 00 to 23"
                    inputMode="numeric"
                    value={hour}
                    onChange={e => typeTime(e.target.value, 23, setHour, h => put(date, h, minute || '0'))}
                    onBlur={() => settleTime(hour, 23, setHour)}
                    onKeyDown={e => { if (e.key === 'Enter') onClose(); }}
                />
                <i>:</i>
                <input
                    aria-label="Minute, 00 to 59"
                    inputMode="numeric"
                    value={minute}
                    onChange={e => typeTime(e.target.value, 59, setMinute, m => put(date, hour || '0', m))}
                    onBlur={() => settleTime(minute, 59, setMinute)}
                    onKeyDown={e => { if (e.key === 'Enter') onClose(); }}
                />
                <em>24-hour</em>
                <button type="button" className="dt24-done" onClick={onClose}>Done</button>
            </div>
        </div>
    );
}
