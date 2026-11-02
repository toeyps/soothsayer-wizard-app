import { useCallback, useContext, useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useCutRuns, useLineCut, useNameFit, useTwoLine, useWideTail } from '../../hooks/useNameFit';
import {
    NAME_TAIL_MAX, afterPrefix, commonPrefix, compactName, displayedName, namesAfterPrefix, splitInSet, widerTailForms, withWiderTail,
    type NameSplit,
} from '../../utils/sensorNames';
import type { SensorMetadata, SpecialSensorRecipe } from '../../types';
import {
    SensorMetaContext, SensorNamesContext, SensorSearchContext, SensorSetContext, SensorSetDropContext,
    SensorSetExtraContext, sensorTitle, useLayeredSensorLookup, useSensorLookup, type SensorInfo,
} from './sensorInfo';

export { SensorNamesContext, SensorSearchContext, SensorSetContext, SensorSetDropContext, SensorSetExtraContext };

/**
 * The ONE sensor label (DESIGN_SYSTEM §4 "Sensor label — ONE standard"):
 * description first, tag second, in two variants of one component.
 *  - `SensorLabel` (Stacked): lists, cards, headers — line 1 description + unit chip, line 2 tag.
 *  - `SensorInline` (Inline): picker triggers/rows, chips, condition rows, chart subtitles,
 *    tooltips — description then tag on one line, no brackets.
 * No description → the tag alone, in mono, on line 1 (never a "no description" placeholder,
 * never the tag twice). Every label carries `title` = "DESCRIPTION · TAG · UNIT · Component".
 *
 * Long names (§4 "Long sensor names"): every rule works on the displayed name and is a measured no-op for a
 * name that fits. A name is printed as one plain text node until it has been MEASURED as cut, so a name that
 * fits has exactly the markup it would have without these rules. A name of at most 28 characters outside a
 * cut set does not even run the measuring hooks.
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

/**
 * Wraps a set whose rows are all sensors (a list, a chip row, a picker group). Rule 3 runs on every label inside;
 * the start they share is worked out once and, only while a row is measured as cut, every label prints it muted,
 * or drops it when `drop` is set (print it once with `SetPrefixLine`).
 *  - `tags`: the set, resolved through the provider to displayed names. Tags from `SensorSetExtraContext` count too.
 *  - `names`: the displayed names directly, instead of `tags`.
 *  - `candidate`: overrides the shared start (a family inside the set).
 *  - `roomOf`: when the set sits in something that shrinks to its content, the ancestor whose width decides that a
 *    shortened set has room again (`useCutRuns`).
 */
export function SensorSetProvider({ tags, names: givenNames, candidate, drop, roomOf, children }: {
    tags?: readonly string[];
    names?: readonly string[];
    candidate?: string;
    drop?: boolean;
    roomOf?: (root: HTMLElement) => HTMLElement | null | undefined;
    children: ReactNode;
}) {
    const lookup = useSensorLookup();
    const extra = useContext(SensorSetExtraContext);
    const names = useMemo(() => {
        if (givenNames) return givenNames;
        if (!tags?.length) return [];
        return [...tags, ...extra.filter(t => t && !tags.includes(t))].map(t => displayedName(lookup(t)));
    }, [givenNames, tags, lookup, extra]);
    const cand = useMemo(() => candidate ?? commonPrefix(names), [names, candidate]);
    const run = useId();
    const sentinel = useRef<HTMLElement>(null);
    const setKey = useMemo(() => `${cand}|${names.join('|')}`, [cand, names]);
    const cut = useCutRuns(() => sentinel.current?.parentElement ?? null, setKey, !!cand, { roomOf });
    // No shared start to decide: nothing to measure, so the labels carry no measuring attributes.
    const namesValue = useMemo(() => ({ names, run: cand ? run : '' }), [names, run, cand]);
    const body = (
        <SensorSetContext.Provider value={cut.has(run) ? cand : ''}>
            <SensorNamesContext.Provider value={namesValue}>
                {children}
                {cand && <i hidden ref={sentinel} />}
            </SensorNamesContext.Provider>
        </SensorSetContext.Provider>
    );
    return drop === undefined ? body : <SensorSetDropContext.Provider value={drop}>{body}</SensorSetDropContext.Provider>;
}

/** The start shared by the surrounding `SensorSetProvider`, printed once. Nothing while no row is cut. */
export function SetPrefixLine({ className, testid = 'set-prefix' }: { className: string; testid?: string }) {
    const prefix = useContext(SensorSetContext);
    if (!prefix) return null;
    return (
        <div className={className} data-testid={testid} title={`Every sensor below starts with: ${prefix}`}>
            {prefix} <span aria-hidden="true">…</span>
        </div>
    );
}

function marked(text: string, q: string): ReactNode {
    if (!q) return text;
    const out: ReactNode[] = [];
    const low = text.toLowerCase();
    let i = 0;
    let k = 0;
    for (let j = low.indexOf(q); j >= 0; j = low.indexOf(q, i)) {
        if (j > i) out.push(text.slice(i, j));
        out.push(<mark key={k++} className="sl-hit">{text.slice(j, j + q.length)}</mark>);
        i = j + q.length;
    }
    out.push(text.slice(i));
    return out;
}

const SEGMENT_SEP = /\s[-–—·|/]\s/g;

/** A match that sits in the cut head is brought next to the tail ("… slide 11B - Segment No 1 - avg"). */
function headShowingMatch(sp: NameSplit, q: string): string {
    const { head } = sp;
    if (!q || !head || sp.shared || sp.pre) return head;
    const at = head.toLowerCase().indexOf(q);
    if (at <= 0 || sp.tail.toLowerCase().includes(q)) return head;
    let segment = 0;
    for (const m of head.matchAll(SEGMENT_SEP)) {
        const end = (m.index ?? 0) + m[0].length;
        if (end <= at) segment = end;
    }
    return segment > 0 ? `… ${head.slice(segment)}` : head;
}

interface LongNameProps {
    /** The text this label prints (the shared start already dropped when the set drops it). */
    text: string;
    names: readonly string[];
    prefix?: string;
    className: string;
    wrap?: boolean;
    stack?: boolean;
    q: string;
    measure: { 'data-name-run'?: string; 'data-name-full'?: string };
}

/** A name that may be cut. Plain text until measured as cut (or until its set's shared start is active). */
function LongName({ text, names, prefix, className, wrap, stack, q, measure }: LongNameProps) {
    const [lineRef, lineCut] = useLineCut(text);
    const shared = !!prefix && text.startsWith(prefix);
    const active = lineCut || shared;
    const sp = useMemo<NameSplit>(
        () => (active ? splitInSet(text, names, prefix) : { head: '', tail: text, shared: false }),
        [active, text, names, prefix],
    );
    const canStack = active && !sp.shared && !!sp.head && (!!wrap || (!!stack && !!sp.pre));
    const [twoRef, two] = useTwoLine(compactName(sp), text, canStack, !!wrap);
    const { forms, starts } = useMemo(() => widerTailForms(sp), [sp]);
    const [wideRef, wideK] = useWideTail(forms, active && !wrap && !two && forms.length > 1);
    const shown = withWiderTail(sp, starts, wideK);
    const pre = shown.pre ?? '';
    const form = !shown.head ? 'plain' : two ? 'two-line' : wrap ? 'wrap' : 'split';
    const fitRef = useNameFit(
        `${form}\0${pre}\0${shown.head}\0${shown.tail}`,
        form === 'two-line' || (form === 'split' && !shown.shared),
    );
    const ref = useCallback((el: HTMLElement | null) => {
        lineRef(el);
        twoRef(el);
        wideRef(el);
        fitRef(el);
    }, [lineRef, twoRef, wideRef, fitRef]);

    // Each form is its own element: what the fit helpers set on a split (data-short, sizes) must not outlive it.
    if (form === 'plain') return <span key="plain" ref={ref} className={className} {...measure}>{marked(text, q)}</span>;
    if (form === 'two-line') {
        return (
            <span key="two-line" ref={ref} className={className} data-name-form="two-line" {...measure}>
                <span data-name-part="line1">
                    {pre && <span data-name-part="pre">{marked(pre, q)}</span>}
                    <span data-name-part="head">{marked(shown.head2 ?? shown.head, q)}</span>
                </span>
                <span data-name-part="tail">{marked((shown.tail2 ?? shown.tail).trimStart(), q)}</span>
            </span>
        );
    }
    if (form === 'wrap') {
        return (
            <span key="wrap" ref={ref} className={`${className} sl-wrapname`} {...measure}>
                {shown.shared
                    ? <><span className="sl-head--shared" data-name-part="head">{shown.head}</span>{marked(shown.tail, q)}</>
                    : marked(text, q)}
            </span>
        );
    }
    return (
        <span
            key="split"
            ref={ref}
            className={`${className} sl-split${shown.shared ? ' sl-split--shared' : ''}${pre ? ' sl-split--pre' : ''}`}
            {...measure}
        >
            {pre && <span data-name-part="pre">{marked(pre, q)}</span>}
            <span data-name-part="head">{marked(headShowingMatch(shown, q), q)}</span>
            <span data-name-part="tail">{marked(shown.tail, q)}</span>
        </span>
    );
}

/**
 * The name text of a label.
 *  - `prefix`: an explicit shared start; '' = none and not part of the surrounding set (a tag).
 *  - `wrap`: a row with room for two lines: a name that does not fit wraps at word breaks.
 *  - `stack`: a stacked row: a kept start + end that do not fit on one line go on two lines.
 */
export function NameText({ text, prefix, className = 'sl-desc', wrap, stack }: {
    text: string;
    prefix?: string;
    className?: string;
    wrap?: boolean;
    stack?: boolean;
}) {
    const setPrefix = useContext(SensorSetContext);
    const drop = useContext(SensorSetDropContext);
    const { names: setNames, run } = useContext(SensorNamesContext);
    const q = useContext(SensorSearchContext).trim().toLowerCase();
    const inSet = prefix === undefined;
    const pfx = (inSet ? setPrefix : prefix) || undefined;
    const dropped = !!pfx && drop && text.startsWith(pfx) && text.length - pfx.length >= 2;
    const printed = dropped ? afterPrefix(text, pfx) : text;
    const names = useMemo(() => {
        if (!inSet) return [];
        return dropped ? namesAfterPrefix(setNames, pfx) : setNames;
    }, [inSet, dropped, setNames, pfx]);
    const measure = inSet && run ? { 'data-name-run': run, 'data-name-full': text } : {};
    const splitPrefix = dropped ? undefined : pfx;
    if (printed.length <= NAME_TAIL_MAX && !(splitPrefix && printed.startsWith(splitPrefix))) {
        return <span className={className} {...measure}>{marked(printed, q)}</span>;
    }
    return <LongName text={printed} names={names} prefix={splitPrefix} className={className} wrap={wrap} stack={stack} q={q} measure={measure} />;
}

/** The tag beside a description; a long one is cut like a name instead of running under the row's buttons. */
function TagText({ tag }: { tag: string }) {
    return <NameText text={tag} prefix="" className={tag.length > NAME_TAIL_MAX ? 'sl-tag sl-tag--long' : 'sl-tag'} />;
}

export function FxBadge({ special }: { special?: 'f' | 's' }) {
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
    /** An explicit shared start (overrides the surrounding set). */
    prefix?: string;
    /** Stacked only: when no tag line prints (no description, or rule 3b), a name that does not fit may use
     *  two lines, its distinguishing end on line 2. A name that fits stays on one line. */
    wrap?: boolean;
}

/** 'md' is the base look (no modifier class). */
const sizeClass = (size: 'sm' | 'md' | 'lg', muted?: boolean) =>
    [size === 'md' ? '' : `sl--${size}`, muted ? 'sl--muted' : ''].filter(Boolean).join(' ');

/** Stacked label. */
export function SensorLabel({ tag, info, unit = true, size = 'md', muted, className = '', style, after, prefix, wrap }: LabelProps) {
    const lookup = useSensorLookup();
    const i = info ?? lookup(tag);
    const showTag = !!i.description && !i.tagHidden;
    return (
        <span
            className={['sl', sizeClass(size, muted), i.description ? '' : 'sl--notag', className].filter(Boolean).join(' ')}
            title={sensorTitle(i)}
            style={style}
        >
            <span className="sl-l1">
                <FxBadge special={i.special} />
                <NameText text={i.description || i.tag} prefix={prefix} wrap={wrap && !after && !showTag} stack />
                {unit && i.unit && <span className="unit-badge sl-unit">{i.unit}</span>}
            </span>
            {(showTag || after) && (
                <span className="sl-l2">
                    {showTag && <TagText tag={i.tag} />}
                    {after}
                </span>
            )}
        </span>
    );
}

/** Inline label. */
export function SensorInline({ tag, info, size = 'md', muted, fit, className = '', style, prefix }: LabelProps) {
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
                <NameText text={i.description || i.tag} prefix={prefix} />
                {i.description && !i.tagHidden && <TagText tag={i.tag} />}
            </span>
        </span>
    );
}
