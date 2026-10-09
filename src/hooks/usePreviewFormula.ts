import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
    FormulaIssue,
    FormulaPreviewInput,
    FormulaPreviewLimits,
    FormulaPreviewResult,
    FormulaPreviewStats,
} from '../types/formula';
import { bindToGeneration, isStaleSessionText, StaleSessionError } from '../utils/staleSession';

/**
 * The Formula editor's live check + preview (customer batch 2026-10, item 6):
 * debounced, bounded calls of Rust's `preview_formula`, which answers with the
 * SAME gate, codes and messages Create / Save use, plus stats over every row
 * and a <= `maxPoints` min/max-preserving downsample.
 *
 * Decision (phase 5): the editor's live check moves from `validate_formula` to
 * `preview_formula`. `validate_formula` has no edit mode, so it applied the
 * create-only refusals (`div_zero`, a one-source block) to a sensor being
 * EDITED, which Save (`replace: true`) skips -- the check and Save could
 * disagree. Sending `replace` here makes them answer alike. (`validate_formula`
 * is still used by the Add Sensor window to say why a stored recipe could not
 * be restored.)
 *
 * Request: `{ formula | aggregate, maxPoints, expectedGeneration, replace,
 * requestId }` -- camelCase keys (Tauri's default; `preview_formula` has no
 * `rename_all`). `expectedGeneration` is stamped by `bindToGeneration`.
 *
 * Ordering:
 *  - Debounced (~220 ms): a newer input replaces a scheduled one.
 *  - Every call carries a fresh, monotonically increasing `requestId`. Rust
 *    keeps ONE token for the app and stops a running preview whose id is no
 *    longer the latest (`CANCELLED: …`). Only one editor previews at a time;
 *    the latest id this window sent is tracked at module level.
 *  - A `CANCELLED:` reply is re-issued only when its id is STILL the latest
 *    this window sent (another window's preview pre-empted it), at most
 *    twice; otherwise a newer call of ours is already on its way.
 *  - A reply for an input that is no longer this hook's current one is dropped.
 *  - `STALE_SESSION` (the window outlived its dataset) is "no information"
 *    (`stale: true`), never a red formula error.
 *
 * Fields describe the LAST answer received; `isCurrent` says whether it is for
 * the current input (keep showing the last chart while the next one loads, but
 * judge validity only from a current answer -- see `resolveFormulaVerdict`).
 * The effect depends on a key string only, so unrelated re-renders do no work.
 */

export const PREVIEW_DEBOUNCE_MS = 220;
export const PREVIEW_MAX_POINTS = 600;
/** Rust's `FORMULA_PREVIEW_CANCELLED` starts with this. */
export const PREVIEW_CANCELLED_PREFIX = 'CANCELLED';
const MAX_REISSUES = 2;

// ── module-level: one editor previews at a time ──────────────────────────────
let requestCounter = 0;
let latestSentId = 0;
let knownFunctions: string[] | null = null;
let knownLimits: FormulaPreviewLimits | null = null;

/** The engine's function list from the last preview this window received
 *  (null before the first). Rust is its only source. */
export function getKnownFormulaFunctions(): string[] | null {
    return knownFunctions;
}

/** Test seam: forget the module-level state. */
export function __resetPreviewFormulaModule(): void {
    requestCounter = 0;
    latestSentId = 0;
    knownFunctions = null;
    knownLimits = null;
}

export interface UsePreviewFormulaOptions {
    /** What to preview; null (or a blank formula) = nothing -- clears the answer. */
    input: FormulaPreviewInput | null;
    /** The Rust dataset generation the window is bound to (`expectedGeneration`). */
    generation?: number;
    /** `true` when editing / restoring an existing sensor -- the SAME value Save
     *  sends as `replace` (Rust then skips the create-only refusals). */
    replace?: boolean;
    maxPoints?: number;
    debounceMs?: number;
}

export interface UsePreviewFormulaReturn {
    /** Rust's verdict of the last answered input; null = no answer (none yet,
     *  nothing to preview, stale session or a failed call). */
    ok: boolean | null;
    issues: FormulaIssue[];
    stats: FormulaPreviewStats | null;
    timestamps: string[];
    values: (number | null)[];
    period: [string, string] | null;
    /** The engine's function list (sticky across answers and editors). */
    functions: string[] | null;
    limits: FormulaPreviewLimits | null;
    converted_formula: string | null;
    /** A call for the current input is scheduled or in flight. */
    loading: boolean;
    /** The answer above belongs to the current input. */
    isCurrent: boolean;
    /** Rust answered STALE_SESSION: this window's dataset is gone. */
    stale: boolean;
    /** Another rejection (`No data loaded`, `BAD_REQUEST:` …), verbatim. */
    error: string | null;
}

/** A stable string for an input + options (what the effect keys on). */
export function previewInputKey(input: FormulaPreviewInput | null, replace = false, generation?: number, maxPoints = PREVIEW_MAX_POINTS): string | null {
    if (!input) return null;
    if (input.formula !== undefined) {
        if (!input.formula.trim()) return null;
        return JSON.stringify(['f', input.formula, replace, generation ?? null, maxPoints]);
    }
    const a = input.aggregate;
    return JSON.stringify(['a', a.type, a.sources, a.decimals ?? null, replace, generation ?? null, maxPoints]);
}

function isPreviewResult(x: unknown): x is FormulaPreviewResult {
    return !!x && typeof x === 'object'
        && typeof (x as { ok?: unknown }).ok === 'boolean'
        && Array.isArray((x as { issues?: unknown }).issues);
}

const isCancelled = (err: unknown) =>
    (err instanceof Error ? err.message : String(err ?? '')).startsWith(PREVIEW_CANCELLED_PREFIX);

interface Answer {
    key: string | null;
    result: FormulaPreviewResult | null;
    stale: boolean;
    error: string | null;
}

const EMPTY: Answer = { key: null, result: null, stale: false, error: null };

export function usePreviewFormula(options: UsePreviewFormulaOptions): UsePreviewFormulaReturn {
    const { input, generation, replace = false } = options;
    const maxPoints = options.maxPoints ?? PREVIEW_MAX_POINTS;
    const debounceMs = options.debounceMs ?? PREVIEW_DEBOUNCE_MS;
    const key = previewInputKey(input, replace, generation, maxPoints);

    const [answer, setAnswer] = useState<Answer>(EMPTY);
    const [loading, setLoading] = useState(false);
    const [functions, setFunctions] = useState<string[] | null>(knownFunctions);
    const [limits, setLimits] = useState<FormulaPreviewLimits | null>(knownLimits);

    // The input the current key was computed from (read by the effect, which
    // keys on the string only).
    const latest = useRef({ input, generation, replace, maxPoints });
    latest.current = { input, generation, replace, maxPoints };
    const seq = useRef(0);

    useEffect(() => {
        const mySeq = ++seq.current;
        if (key === null) {
            setLoading(false);
            setAnswer(EMPTY);
            return;
        }
        setLoading(true);
        const { input: req, generation: gen, replace: rep, maxPoints: points } = latest.current;
        const send = async (attempt: number): Promise<void> => {
            const id = ++requestCounter;
            latestSentId = id;
            try {
                const call = bindToGeneration((cmd, args) => invoke<unknown>(cmd, args), gen);
                const reply = await call('preview_formula', {
                    formula: req!.formula,
                    aggregate: req!.aggregate,
                    maxPoints: points,
                    replace: rep,
                    requestId: id,
                });
                if (mySeq !== seq.current) return; // a newer input was scheduled meanwhile
                if (!isPreviewResult(reply)) {
                    // A mock / an old backend: no information, never "invalid".
                    setAnswer({ key, result: null, stale: false, error: null });
                    setLoading(false);
                    return;
                }
                if (Array.isArray(reply.functions) && reply.functions.length > 0) {
                    knownFunctions = reply.functions;
                    setFunctions(reply.functions);
                }
                if (reply.limits) {
                    knownLimits = reply.limits;
                    setLimits(reply.limits);
                }
                setAnswer({ key, result: reply, stale: false, error: null });
                setLoading(false);
            } catch (err) {
                if (mySeq !== seq.current) return;
                if (isCancelled(err)) {
                    // Pre-empted by another window's preview while ours was the
                    // latest we sent: ask again. Otherwise a newer call of ours
                    // is already on its way and will answer.
                    if (id === latestSentId && attempt < MAX_REISSUES) return send(attempt + 1);
                    setLoading(false);
                    return;
                }
                const stale = err instanceof StaleSessionError || isStaleSessionText(err);
                setAnswer({ key, result: null, stale, error: stale ? null : err instanceof Error ? err.message : String(err) });
                setLoading(false);
            }
        };
        const timer = setTimeout(() => { void send(0); }, debounceMs);
        return () => clearTimeout(timer);
    }, [key, debounceMs]);

    // Drop any reply still in flight after unmount.
    useEffect(() => () => { seq.current++; }, []);

    const r = answer.result;
    return {
        ok: r ? r.ok : null,
        issues: r?.issues ?? [],
        stats: r?.stats ?? null,
        timestamps: r?.timestamps ?? [],
        values: r?.values ?? [],
        period: r?.period ?? null,
        functions,
        limits,
        converted_formula: r?.converted_formula ?? null,
        loading,
        isCurrent: answer.key !== null && answer.key === key,
        stale: answer.stale,
        error: answer.error,
    };
}

/** What the check line shows and whether Add / Save are blocked. */
export interface FormulaVerdict {
    /** The issue to show (Rust's when it answered for the current input,
     *  else the front-end check's); null = nothing wrong known. */
    issue: FormulaIssue | null;
    source: 'rust' | 'check' | null;
    /** true = Rust confirmed it; false = refused; null = not known yet. */
    valid: boolean | null;
}

/**
 * Combine the cheap front-end check with Rust's answer. Rust has the last
 * word: a current Rust answer replaces the front-end verdict entirely (in
 * both directions); until it lands, the front-end issue (if any) is shown.
 */
export function resolveFormulaVerdict(
    cheap: FormulaIssue | null,
    preview: Pick<UsePreviewFormulaReturn, 'isCurrent' | 'ok' | 'issues'>,
): FormulaVerdict {
    if (preview.isCurrent && preview.ok !== null) {
        if (preview.ok) return { issue: null, source: 'rust', valid: true };
        return {
            issue: preview.issues[0] ?? { code: 'parse_error', message: 'This formula is not valid.' },
            source: 'rust',
            valid: false,
        };
    }
    if (cheap) return { issue: cheap, source: 'check', valid: false };
    return { issue: null, source: null, valid: null };
}
