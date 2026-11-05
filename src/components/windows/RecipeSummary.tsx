import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLineCut } from '../../hooks/useNameFit';
import { afterPrefix, commonPrefix } from '../../utils/sensorNames';
import { fontOf, textWidth } from '../../utils/textMeasure';
import type { SpecialSensorRecipe } from '../../types';
import type { SpecialSensorDescription } from '../../utils/specialSensorDescribe';
import { NameText } from '../sensor/SensorLabel';

/** `$TAG` / `${TAG}` in a formula's own text. */
const REF = /\$\{([^}]+)\}|\$([\p{Alphabetic}\p{N}_][\p{Alphabetic}\p{N}_.]*)/gu;

const Text = ({ children, end }: { children: ReactNode; end?: boolean }) => (
    <span className={end ? 'rsum-t rsum-end' : 'rsum-t'}>{children}</span>
);
/** One sensor reference: never shrinks below "…" + its tail (`applyNameFit` holds it open). */
const Ref = ({ name, open = '', close = '' }: { name: string; open?: string; close?: string }) => (
    <span className="rsum-ref" data-name-ref>
        {open && <Text>{open}</Text>}
        <NameText text={name} prefix="" className="rsum-name" />
        {close && <Text>{close}</Text>}
    </span>
);

/** Every sensor name of a recipe at most this long: its text stays as it always was, end-cut if it must be. */
const SHORT_NAME_MAX = 36;

/** Room kept for the end of the summary ("· missing…") when deciding whether the sources can be read. */
const END_MIN_PX = 48;
/** A shared start with less room than this says nothing ("Cr…"): it is not printed. */
const PREFIX_MIN_PX = 56;

/** The summary as parts, or null when it has no long sensor name, or none can be found in its text.
 *  `roomPx`: the width of the line. */
function summaryParts(recipe: SpecialSensorRecipe, desc: SpecialSensorDescription, describe: (tag: string) => string, roomPx: number, font: string): ReactNode | null {
    const text = desc.summary;
    const named = recipe.kind === 'formula' ? [...text.matchAll(REF)].map(m => m[1] ?? m[2]) : desc.sources.map(describe);
    if (named.every(n => n.length <= SHORT_NAME_MAX)) return null;
    if (recipe.kind === 'formula') {
        // A formula keeps its own `$TAG` text: tags stay allowed there.
        const parts: ReactNode[] = [];
        let at = 0;
        for (const m of text.matchAll(REF)) {
            const i = m.index ?? 0;
            if (i > at) parts.push(<Text key={`t${i}`}>{text.slice(at, i)}</Text>);
            const braced = m[1] !== undefined;
            parts.push(<Ref key={`r${i}`} name={m[1] ?? m[2]} open={braced ? '${' : '$'} close={braced ? '}' : ''} />);
            at = i + m[0].length;
        }
        if (parts.length === 0) return null;
        if (at < text.length) parts.push(<Text key="end">{text.slice(at)}</Text>);
        return parts;
    }
    const names = desc.sources.map(describe);
    if (names.length > 1) {
        const joined = names.join(', ');
        const i = text.indexOf(joined);
        if (i < 0) return null;
        const lead = text.slice(0, i);
        const end = text.slice(i + joined.length);
        // Several sources: shared start once, then each end whole. If they don't fit, show a count; `title` lists them.
        const prefix = commonPrefix(names);
        const list = (prefix ? names.map(n => afterPrefix(n, prefix)) : names).join(', ');
        const left = roomPx - textWidth(`${lead}${list}`, font) - (end ? END_MIN_PX : 0);
        if (left < 0) {
            return (
                <>
                    <Text>{lead}{names.length} sensors</Text>
                    <Text end>{end}</Text>
                </>
            );
        }
        return (
            <>
                <Text>{lead}</Text>
                {prefix && left >= PREFIX_MIN_PX && <span className="rsum-pre" data-testid="recipe-summary-prefix">{prefix} ·&nbsp;</span>}
                <Text>{list}</Text>
                <Text end>{end}</Text>
            </>
        );
    }
    const a = names[0] ?? '';
    const i = a ? text.indexOf(a) : -1;
    if (i < 0) return null;
    return (
        <>
            {i > 0 && <Text>{text.slice(0, i)}</Text>}
            <Ref name={a} />
            <Text>{text.slice(i + a.length)}</Text>
        </>
    );
}

/** Manage list's one-line recipe: plain text while it fits; once cut, only sensor names are cut in the middle (DESIGN_SYSTEM §4 rule 1), words and operators never shrink. Full recipe in `title`. */
export function RecipeSummary({ recipe, desc, describe }: {
    recipe: SpecialSensorRecipe;
    desc: SpecialSensorDescription | undefined;
    describe: (tag: string) => string;
}) {
    const text = desc?.summary ?? '';
    const [lineRef, cut] = useLineCut(text);
    const el = useRef<HTMLElement | null>(null);
    const ref = useCallback((node: HTMLElement | null) => { el.current = node; lineRef(node); }, [lineRef]);
    // The line's width comes from the row, never from what it prints, so the form picked here cannot change its room.
    const [room, setRoom] = useState({ px: 0, font: '' });
    useLayoutEffect(() => {
        const node = el.current;
        if (!cut || !node) return;
        const read = () => {
            const px = node.clientWidth;
            setRoom(r => (r.px === px ? r : { px, font: fontOf(node) }));
        };
        read();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(read);
        ro.observe(node);
        return () => ro.disconnect();
    }, [cut]);
    const parts = cut && desc ? summaryParts(recipe, desc, describe, room.px, room.font) : null;
    // A cut line of several sources may only count them: `title` lists them.
    const listed = !!parts && recipe.kind !== 'formula' && !!desc && desc.sources.length > 1;
    return (
        <div
            ref={ref}
            className={parts ? 'hidden md:flex rsum' : 'hidden md:block truncate'}
            title={listed && desc ? desc.sources.map(describe).join('\n') : desc?.expression}
            data-testid={`recipe-summary-${recipe.tag}`}
            data-name-summary={parts ? '' : undefined}
            style={{ flex: '0 1 260px', fontFamily: recipe.kind === 'formula' ? 'var(--mono)' : undefined, fontSize: '11px', color: 'var(--text-secondary)' }}
        >
            {parts ?? desc?.summary}
        </div>
    );
}
