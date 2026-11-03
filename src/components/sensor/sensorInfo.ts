import { createContext, useContext, useMemo } from 'react';
import type { SensorMetadata, SpecialSensorRecipe } from '../../types';
import { normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { commonPrefix, sameNameLoosely, splitName } from '../../utils/sensorNames';
import { layoutTooltipRow } from '../../utils/tooltipLayout';

export { sameNameLoosely };

/**
 * The data every sensor label, picker row and tooltip needs, resolved from the tag
 * (DESIGN_SYSTEM §4 "Sensor label"; spec: `docs/design/handoff/customer-batch-2026-10/README.md` §1).
 *
 * Metadata reaches the components through React context (`SensorMetaProvider`), never through a
 * module-level registry: each window wraps its tree once, and a panel that receives its own
 * `sensorMetadata` prop nests another provider (own entries win, everything else is inherited).
 * A component with no provider above it still renders — every tag then reads as "no description"
 * (the tag alone), which is also the shipped fallback for a tag missing from the Tag names file.
 */
export interface SensorInfo {
    tag: string;
    /** Undefined when the Tag names file has none, or when it only repeats the tag. */
    description?: string;
    unit?: string;
    component?: string;
    /** Special sensor badge: 'f' = formula (ƒ), 's' = aggregate / operation (Σ). */
    special?: 'f' | 's';
    /** Rule 3b: the tag only re-spells the description, so it is not printed beside it (it stays in
     *  `title`, search and the hover card). Undefined when the tag is printed. */
    tagHidden?: boolean;
}

export type SensorLookup = (tag: string) => SensorInfo;

const clean = (s: string | undefined | null): string | undefined => {
    const t = (s ?? '').trim();
    return t ? t : undefined;
};

/** The provider-less lookup: every tag is "tag only". Cached so a repeated lookup returns the
 *  same object (cheap to compare in memoised children). */
const plainCache = new Map<string, SensorInfo>();
export const plainSensorLookup: SensorLookup = (tag) => {
    let hit = plainCache.get(tag);
    if (!hit) {
        hit = { tag };
        if (plainCache.size > 5000) plainCache.clear();
        plainCache.set(tag, hit);
    }
    return hit;
};

/**
 * Builds a lookup over `metadata` / `special`, falling back to `parent` for anything they do not
 * cover. `metadata === undefined` (or `special === undefined`) means "inherit the parent's";
 * an explicit array — even an empty one — replaces it for the tags it contains only. Results are
 * cached per tag for the lifetime of the returned function (i.e. until an input changes), so the
 * per-call cost in render loops and tooltip formatters is one Map read.
 */
export function buildSensorLookup(
    parent: SensorLookup | null,
    metadata?: SensorMetadata[] | null,
    special?: Pick<SpecialSensorRecipe, 'tag' | 'kind'>[] | null,
): SensorLookup {
    const metaMap = new Map<string, SensorMetadata>();
    for (const m of metadata ?? []) metaMap.set(normalizeSensorTag(m.tag), m);
    const specialMap = new Map<string, 'f' | 's'>();
    for (const r of special ?? []) specialMap.set(normalizeSensorTag(r.tag), r.kind === 'formula' ? 'f' : 's');
    const base = parent ?? plainSensorLookup;
    const cache = new Map<string, SensorInfo>();
    return (tag: string) => {
        const hit = cache.get(tag);
        if (hit) return hit;
        const k = normalizeSensorTag(tag);
        const inherited = base(tag);
        const m = metaMap.get(k);
        let info: SensorInfo;
        if (m) {
            const cleaned = clean(m.description);
            // "Never show the tag twice": a description that only repeats the tag is no description.
            const description = cleaned && normalizeSensorTag(cleaned) !== k ? cleaned : undefined;
            info = {
                tag,
                description,
                unit: clean(m.unit),
                component: clean(m.component),
                special: inherited.special,
            };
            if (sameNameLoosely(description, tag)) info.tagHidden = true;
        } else {
            info = inherited.tag === tag ? { ...inherited } : { ...inherited, tag };
        }
        const sp = specialMap.get(k);
        if (sp) info.special = sp;
        cache.set(tag, info);
        return info;
    };
}

export const SensorMetaContext = createContext<SensorLookup>(plainSensorLookup);

/** Rule 3 inside a set: the sensors printed next to it on the same card (a model's target / Y sensor).
 *  They count in the set's distinct-rows rule, so a chip can never read like the target. */
export const SensorSetExtraContext = createContext<readonly string[]>([]);
/** Rule 2: the start shared by the surrounding set, active only while one of its names is really cut
 *  at the current width; '' otherwise. */
export const SensorSetContext = createContext<string>('');
/** Rule 3: the names of the surrounding set, and its id for the cut measurement ('' = not measured). */
export interface SensorNamesValue { names: readonly string[]; run: string }
export const SensorNamesContext = createContext<SensorNamesValue>({ names: [], run: '' });
/** The start a row's run shares: its name without the distinguishing end. A name whose end is too long to split
 *  still joins its run (its start = all but its last segment). */
export function runKeyOf(name: string): string {
    let head = splitName(name).head;
    if (!head) {
        const seps = [...name.matchAll(/\s[-–—·|/]\s/g)];
        head = seps.length ? name.slice(0, seps[seps.length - 1].index) : '';
    }
    return head.replace(/\s*[-–—·|/]\s*$/, '');
}

export interface NameRun {
    tags: readonly string[];
    names: readonly string[];
    /** The start the run's names share ('' = none worth printing). */
    prefix: string;
}

/** Rule 2 for a long list: consecutive rows with the same start are one run. A list group holds several families
 *  ("… (P-P Trend) …", "Frame …"), so the group as a whole usually shares nothing while each run shares a lot. */
export function nameRuns(tags: readonly string[], nameOf: (tag: string) => string): NameRun[] {
    const out: NameRun[] = [];
    let i = 0;
    while (i < tags.length) {
        const key = runKeyOf(nameOf(tags[i]));
        let j = i + 1;
        while (key && j < tags.length && runKeyOf(nameOf(tags[j])) === key) j++;
        const names = tags.slice(i, j).map(nameOf);
        out.push({ tags: tags.slice(i, j), names, prefix: names.length >= 2 ? commonPrefix(names) : '' });
        i = j;
    }
    return out;
}

/** Rule 2: the shared start is printed elsewhere (`SetPrefixLine`), so the rows drop it. */
export const SensorSetDropContext = createContext<boolean>(false);
/** The list's search text: matches are marked, and a match in the cut-off head moves next to the tail. */
export const SensorSearchContext = createContext<string>('');

/** A lookup over `metadata` / `special` layered on the nearest provider's — for a component that
 *  both provides it to its children (`<SensorMetaContext.Provider value={…}>`) and reads it itself. */
export function useLayeredSensorLookup(
    metadata?: SensorMetadata[] | null,
    special?: Pick<SpecialSensorRecipe, 'tag' | 'kind'>[] | null,
): SensorLookup {
    const parent = useContext(SensorMetaContext);
    return useMemo(() => buildSensorLookup(parent, metadata, special), [parent, metadata, special]);
}

/** The lookup of the nearest `SensorMetaProvider` (or the plain "tag only" one). */
export function useSensorLookup(): SensorLookup {
    return useContext(SensorMetaContext);
}

/** "DESCRIPTION · TAG · UNIT · Component" — the `title` on every label that can truncate. */
export function sensorTitle(info: SensorInfo): string {
    return [info.description, info.tag, info.unit, info.component].filter(Boolean).join(' · ');
}

/** Lower-cased search text: description, tag, unit and component (DESIGN_SYSTEM §4 "Search"). */
export function sensorHaystack(info: SensorInfo): string {
    return `${info.description ?? ''} ${info.tag} ${info.unit ?? ''} ${info.component ?? ''}`.toLowerCase();
}

/** Plain-text inline label for attribute / canvas contexts: "DESCRIPTION · TAG", or the tag alone. */
export function sensorPlainLabel(info: SensorInfo): string {
    return info.description ? `${info.description} · ${info.tag}` : info.tag;
}

const NF = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const NF3 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const NF0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Below this (and above 0) 3 decimals would read as 0 → 3 significant digits instead. */
const TINY = 1e-3;
/** From here decimals are noise next to 10+ integer digits → whole numbers. */
const BIG = 1e9;
/** From here a double no longer holds every integer digit → scientific notation. */
const HUGE = 1e15;

/** Strips trailing zeros of a fraction ("0.000120" → "0.00012", "1.20e-7" → "1.2e-7"). */
const trimZeros = (s: string): string => s.replace(/(\.\d*?)0+(?=$|e)/, '$1').replace(/\.(?=$|e)/, '');

/**
 * The ONE display number formatter for COMPUTED values (tooltips, the tag-point box,
 * stats): en-US, thousands separators, up to 3 decimals (`fixed3` = always 3,
 * for value columns that must line up). Never for a value the user typed (`fmtNumText` /
 * `fmtNumExact`), `<input>` values or CSV.
 *  - 0 < |v| < 0.001 → 3 significant digits (`toPrecision(3)`), so a non-zero value never shows
 *    as 0 ("0.00012"; `fixed3` keeps the padded "0.000120").
 *  - |v| ≥ 1e9 → whole number with separators ("12,345,678,901").
 *  - |v| ≥ 1e15 → scientific, 4 significant digits ("1.235e+15").
 */
export function fmtNum(v: number | null | undefined, fixed3 = false): string {
    if (v == null || !Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a !== 0 && a < TINY) {
        const p = v.toPrecision(3);
        return fixed3 ? p : trimZeros(p);
    }
    if (a >= HUGE) return v.toExponential(3);
    if (a >= BIG) return NF0.format(v);
    return (fixed3 ? NF3 : NF).format(v);
}

/** Decimal places written in a plain or scientific number literal ("0.0005" → 4, "1.50" → 2,
 *  "1e-4" → 4, "12" → 0); null when the text is not such a literal. */
function typedDecimals(t: string): number | null {
    const m = /^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(t);
    if (!m || (m[1] === '' && !m[2])) return null;
    return Math.max(0, (m[2]?.length ?? 0) - (m[3] ? parseInt(m[3], 10) : 0));
}

/** Thousands separators only, exactly `decimals` places; null when that can't be shown exactly. */
function groupExact(n: number, decimals: number): string | null {
    if (decimals > 20 || Math.abs(n) >= HUGE) return null;
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
}

/**
 * A number the USER TYPED, as text (a condition's `value1`, a filter value): thousands
 * separators only — every decimal the user typed is kept, nothing is rounded ("> 0.0005" stays
 * "> 0.0005", "1.50" stays "1.50"). Non-numbers, and literals that can't be shown exactly
 * (> 20 decimals, ≥ 1e15), pass through as typed.
 */
export function fmtNumText(v: string): string {
    const t = v.trim();
    if (t === '') return v;
    const n = Number(t);
    const d = typedDecimals(t);
    if (!Number.isFinite(n) || d === null) return v;
    return groupExact(n, d) ?? t;
}

/** `fmtNumText` for a typed value already parsed to a number (a highlight range's min/max):
 *  every decimal of its shortest form is kept. */
export function fmtNumExact(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '–';
    const s = String(v);
    return groupExact(v, typedDecimals(s) ?? 0) ?? s;
}

/** Escape text for ECharts HTML tooltips (they are rendered as HTML, not text). */
export const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A CSS colour safe to drop into a style attribute (hex / rgb[a] / hsl[a] / oklch / a name). */
export const safeColour = (c: string | undefined): string | undefined =>
    c && /^[#a-zA-Z0-9(),.%\s/-]+$/.test(c) ? c : undefined;

/** The class of a tooltip row: a row that would pass the tooltip's limit wraps its name (rule 4). A row
 *  that fits is plain `tt-row`, exactly as before. For a React row, pass what it prints. */
export function ttRowClass(info: SensorInfo, valueText?: string, distinct?: string): string {
    return layoutTooltipRow({ ...info, valueText, distinct }).wraps ? 'tt-row tt-row--wrap' : 'tt-row';
}

/**
 * HTML for one tooltip row (ECharts HTML formatter): swatch, inline label (description then tag,
 * no brackets), value + unit right-aligned in the series colour. Everything is escaped.
 * `.tt-row` is a grid with the value in its own column, so a long name can never run under it. The
 * description gets the room first: the tag takes what is left and is dropped when that is nothing.
 * `distinct`: what tells the row from one with the same description (`tooltipDistinctEnds`).
 */
export function sensorInlineHtml(info: SensorInfo, colour?: string, valueText?: string, distinct?: string): string {
    const c = safeColour(colour);
    const row = layoutTooltipRow({ ...info, valueText, distinct });
    const name = escapeHtml(row.name);
    const label = info.description
        ? `<span class="tt-desc">${name}</span>${row.tagShown ? `<span class="tt-tag">${escapeHtml(info.tag)}</span>` : ''}`
        : `<span class="tt-desc tt-mono">${name}</span>`;
    const sw = c ? `<i class="tt-sw" style="background:${c}"></i>` : '';
    const val = valueText != null
        ? `<span class="tt-val"${c ? ` style="color:${c}"` : ''}>${escapeHtml(valueText)}</span>`
        : '';
    return `<div class="${row.wraps ? 'tt-row tt-row--wrap' : 'tt-row'}" title="${escapeHtml(sensorTitle(info))}">${sw}<span class="tt-label">${label}</span>${val}</div>`;
}

/** A tooltip row with an axis key (X / Y) in the swatch column (Clusters, Compare). */
export function axisRowHtml(key: string, info: SensorInfo, valueText: string): string {
    return sensorInlineHtml(info, undefined, valueText)
        .replace('<span class="tt-label">', `<b class="tt-key">${escapeHtml(key)}</b><span class="tt-label">`);
}

/** A tooltip row for one line of a chart: its colour, its name and its value in that colour. */
export function lineRowHtml(label: string, colour: string, valueText: string): string {
    const c = safeColour(colour);
    return `<div class="tt-row"><i class="tt-sw" style="background:${c}"></i><span class="tt-label"><span class="tt-desc">${escapeHtml(label)}</span></span><span class="tt-val" style="color:${c}">${escapeHtml(valueText)}</span></div>`;
}

/** A tooltip row that is not a sensor ("Health score"), lined up with `axisRowHtml` rows. */
export function plainRowHtml(label: string, valueText: string): string {
    return `<div class="tt-row"><b class="tt-key"></b><span class="tt-label"><span class="tt-desc">${escapeHtml(label)}</span></span><span class="tt-val">${escapeHtml(valueText)}</span></div>`;
}
