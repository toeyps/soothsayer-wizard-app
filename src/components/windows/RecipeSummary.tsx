import { Fragment, type ReactNode } from 'react';
import { useLineCut } from '../../hooks/useNameFit';
import { afterPrefix, commonPrefix } from '../../utils/sensorNames';
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

/** The summary as parts, or null when it has no long sensor name, or none can be found in its text. */
function summaryParts(recipe: SpecialSensorRecipe, desc: SpecialSensorDescription, describe: (tag: string) => string): ReactNode | null {
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
        // Several sources: the start they share once, then each one's end.
        const prefix = commonPrefix(names);
        return (
            <>
                <Text>{text.slice(0, i)}</Text>
                {prefix && <span className="rsum-pre" data-testid="recipe-summary-prefix">{prefix} ·&nbsp;</span>}
                {names.map((n, j) => (
                    <Fragment key={n}>
                        {j > 0 && <Text>, </Text>}
                        <Ref name={prefix ? afterPrefix(n, prefix) : n} />
                    </Fragment>
                ))}
                <Text end>{text.slice(i + joined.length)}</Text>
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

/**
 * The Manage list's one-line recipe. Plain text while it fits. Only once it is really cut, every sensor name in it
 * is cut in the MIDDLE (DESIGN_SYSTEM §4 rule 1), so the part that tells two recipes apart ("SegmentNo 1 - max",
 * "× 10") is never the part that is lost; words and operators never shrink. The full recipe stays in `title`.
 */
export function RecipeSummary({ recipe, desc, describe }: {
    recipe: SpecialSensorRecipe;
    desc: SpecialSensorDescription | undefined;
    describe: (tag: string) => string;
}) {
    const text = desc?.summary ?? '';
    const [ref, cut] = useLineCut(text);
    const parts = cut && desc ? summaryParts(recipe, desc, describe) : null;
    return (
        <div
            ref={ref}
            className={parts ? 'hidden md:flex rsum' : 'hidden md:block truncate'}
            title={desc?.expression}
            data-testid={`recipe-summary-${recipe.tag}`}
            data-name-summary={parts ? '' : undefined}
            style={{ flex: '0 1 260px', fontFamily: recipe.kind === 'formula' ? 'var(--mono)' : undefined, fontSize: '11px', color: 'var(--text-secondary)' }}
        >
            {parts ?? desc?.summary}
        </div>
    );
}
