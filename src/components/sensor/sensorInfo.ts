import { createContext, useContext, useMemo } from 'react';
import type { SensorMetadata, SpecialSensorRecipe } from '../../types';
import { normalizeSensorTag } from '../../hooks/useSensorMetaMap';

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
            const description = clean(m.description);
            info = {
                tag,
                // "Never show the tag twice": a description that only repeats the tag is no description.
                description: description && normalizeSensorTag(description) !== k ? description : undefined,
                unit: clean(m.unit),
                component: clean(m.component),
                special: inherited.special,
            };
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

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A CSS colour safe to drop into a style attribute (hex / rgb[a] / hsl[a] / oklch / a name). */
const safeColour = (c: string | undefined): string | undefined =>
    c && /^[#a-zA-Z0-9(),.%\s/-]+$/.test(c) ? c : undefined;

/**
 * HTML for one tooltip row (ECharts HTML formatter): swatch, inline label (description then tag,
 * no brackets), value + unit right-aligned in the series colour. Everything is escaped.
 */
export function sensorInlineHtml(info: SensorInfo, colour?: string, valueText?: string): string {
    const c = safeColour(colour);
    const label = info.description
        ? `<span class="tt-desc">${escapeHtml(info.description)}</span><span class="tt-tag">${escapeHtml(info.tag)}</span>`
        : `<span class="tt-desc tt-mono">${escapeHtml(info.tag)}</span>`;
    const sw = c ? `<i class="tt-sw" style="background:${c}"></i>` : '';
    const val = valueText != null
        ? `<span class="tt-val"${c ? ` style="color:${c}"` : ''}>${escapeHtml(valueText)}</span>`
        : '';
    return `<div class="tt-row" title="${escapeHtml(sensorTitle(info))}">${sw}<span class="tt-label">${label}</span>${val}</div>`;
}
