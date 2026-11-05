import { Fragment, useCallback, useContext, useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useCutRuns, useLineCut, useNameFit, useTwoLine, useWideTail } from '../../hooks/useNameFit';
import {
    NAME_TAIL_MAX, afterPrefix, commonPrefix, compactName, displayedName, namesAfterPrefix, splitInSet, widerTailForms, withWiderTail,
    type NameSplit,
} from '../../utils/sensorNames';
import { layoutTooltipRow } from '../../utils/tooltipLayout';
import type { SensorMetadata, SpecialSensorRecipe } from '../../types';
import {
    SensorMetaContext, SensorNamesContext, SensorSearchContext, SensorSetContext, SensorSetDropContext,
    SensorSetExtraContext, sensorTitle, useLayeredSensorLookup, useSensorLookup, type SensorInfo,
} from './sensorInfo';

export { SensorNamesContext, SensorSearchContext, SensorSetContext, SensorSetDropContext, SensorSetExtraContext };

/** The one sensor label: description first, tag second; `SensorLabel` is stacked, `SensorInline` is one line. */

/** Supplies sensor metadata to labels and pickers below; nested providers inherit what they lack. */
export function SensorMetaProvider({ metadata, special, children }: {
    metadata?: SensorMetadata[] | null;
    special?: Pick<SpecialSensorRecipe, 'tag' | 'kind'>[] | null;
    children: ReactNode;
}) {
    const lookup = useLayeredSensorLookup(metadata, special);
    return <SensorMetaContext.Provider value={lookup}>{children}</SensorMetaContext.Provider>;
}

/** Wraps sensor rows; their shared start is computed once and printed muted (or dropped with `drop`) while a row is cut. */
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
            {prefix}
        </div>
    );
}

const NBSP = '\u00a0';

/** A wrapping row keeps a separator at the end of line 1; same length as the name so search hits still line up. */
const keepSeparatorOnLine = (text: string) => text.replace(/ (?=[-–—·|/] )/g, NBSP);

function marked(text: string, q: string): ReactNode {
    if (!q) return text;
    const out: ReactNode[] = [];
    const low = text.toLowerCase().split(NBSP).join(' ');
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
    /** A row that can grow: prints the whole name, wrapped, never cut. */
    grow?: boolean;
    q: string;
    measure: { 'data-name-run'?: string; 'data-name-full'?: string };
}

/** A name that may be cut. Plain text until measured as cut (or until its set's shared start is active). */
function LongName({ text, names, prefix, className, wrap, stack, grow, q, measure }: LongNameProps) {
    const [lineRef, lineCut] = useLineCut(text);
    const shared = !!prefix && text.startsWith(prefix);
    const active = lineCut || shared;
    const sp = useMemo<NameSplit>(
        () => (active ? splitInSet(text, names, prefix) : { head: '', tail: text, shared: false }),
        [active, text, names, prefix],
    );
    const canStack = !grow && active && !sp.shared && !!sp.head && (!!wrap || (!!stack && !!sp.pre));
    const [twoRef, two] = useTwoLine(compactName(sp), text, canStack, !!wrap);
    const { forms, starts } = useMemo(() => widerTailForms(sp), [sp]);
    const [wideRef, wideK] = useWideTail(forms, active && !wrap && !two && forms.length > 1);
    const shown = withWiderTail(sp, starts, wideK);
    const pre = shown.pre ?? '';
    // A wrapping row wraps a cut name even with no head to split off; a name with no spaces has no break and end-cuts.
    const wrapsWhole = !!wrap && active && !shown.head && /\s/.test(text);
    const form = grow && active ? 'wrap' : wrapsWhole ? 'wrap' : !shown.head ? 'plain' : two ? 'two-line' : wrap ? 'wrap' : 'split';
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
    if (form === 'wrap' && grow) {
        return (
            <span key="grow" ref={ref} className={`${className} sl-wrapname--all`} {...measure}>
                {!q && !/\s/.test(text)
                    ? text.split(/(?<=[_.\-])/).map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>)
                    : marked(keepSeparatorOnLine(text), q)}
            </span>
        );
    }
    if (form === 'wrap') {
        return (
            <span key="wrap" ref={ref} className={`${className} sl-wrapname`} {...measure}>
                {shown.shared
                    ? <><span className="sl-head--shared" data-name-part="head">{shown.head}</span>{marked(keepSeparatorOnLine(shown.tail), q)}</>
                    : marked(keepSeparatorOnLine(text), q)}
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

/** `prefix` = shared start ('' = none); `wrap`/`stack` allow two lines; `grow` prints the whole name, wrapped, no ellipsis. */
export function NameText({ text, prefix, className = 'sl-desc', wrap, stack, grow }: {
    text: string;
    prefix?: string;
    className?: string;
    wrap?: boolean;
    stack?: boolean;
    grow?: boolean;
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
    if (!grow && printed.length <= NAME_TAIL_MAX && !(splitPrefix && printed.startsWith(splitPrefix))) {
        return <span className={className} {...measure}>{marked(printed, q)}</span>;
    }
    return <LongName text={printed} names={names} prefix={splitPrefix} className={className} wrap={wrap} stack={stack} grow={grow} q={q} measure={measure} />;
}

/** The tag beside a description; a long one is cut like a name instead of running under the row's buttons. */
function TagText({ tag, grow }: { tag: string; grow?: boolean }) {
    return <NameText text={tag} prefix="" grow={grow && tag.length > NAME_TAIL_MAX} className={tag.length > NAME_TAIL_MAX ? 'sl-tag sl-tag--long' : 'sl-tag'} />;
}

/** React tooltip row name: wrapping or `distinct` rows print the layout result like ECharts rows; others are plain inline. */
export function TooltipRowName({ info, valueText, distinct }: { info: SensorInfo; valueText?: string; distinct?: string }) {
    const row = layoutTooltipRow({ ...info, valueText, distinct });
    if (!row.wraps && !distinct) return <SensorInline tag={info.tag} info={info} size="sm" />;
    return (
        <>
            <span className={info.description ? 'tt-desc' : 'tt-desc tt-mono'} title={sensorTitle(info)}>{row.name}</span>
            {info.description && row.tagShown && <span className="tt-tag">{info.tag}</span>}
        </>
    );
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
    /** Stacked only: a name with no tag line may wrap to two lines; `'always'` (list row) allows up to 3 lines with the tag. */
    wrap?: boolean | 'always';
}

/** 'md' is the base look (no modifier class). */
const sizeClass = (size: 'sm' | 'md' | 'lg', muted?: boolean) =>
    [size === 'md' ? '' : `sl--${size}`, muted ? 'sl--muted' : ''].filter(Boolean).join(' ');

/** Stacked label. */
export function SensorLabel({ tag, info, unit = true, size = 'md', muted, className = '', style, after, prefix, wrap }: LabelProps) {
    const lookup = useSensorLookup();
    const i = info ?? lookup(tag);
    const showTag = !!i.description && !i.tagHidden;
    const grow = wrap === 'always' && !after;
    return (
        <span
            className={['sl', sizeClass(size, muted), i.description ? '' : 'sl--notag', className].filter(Boolean).join(' ')}
            title={sensorTitle(i)}
            style={style}
        >
            <span className="sl-l1">
                <FxBadge special={i.special} />
                <NameText text={i.description || i.tag} prefix={prefix} wrap={!after && (wrap === 'always' || (!!wrap && !showTag))} stack grow={grow} />
                {unit && i.unit && <span className="unit-badge sl-unit">{i.unit}</span>}
            </span>
            {(showTag || after) && (
                <span className="sl-l2">
                    {showTag && <TagText tag={i.tag} grow={grow} />}
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
