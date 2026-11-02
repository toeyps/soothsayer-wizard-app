/**
 * Pure rules for printing long sensor names (DESIGN_SYSTEM §4 "Long sensor names", rules 1, 2, 3, 3b).
 * Everything works on the DISPLAYED name: the description, or the tag when the sensor has none.
 *
 * A split never changes the name: `pre + head + tail` is the name itself, so a name that fits prints
 * exactly as it would without these rules. WHETHER a name is cut is decided by measuring at render time
 * (`hooks/useNameFit.ts`), never here.
 */

const SEP = /\s[-–—·|/]\s/g;
const SEP_END = /\s*[-–—·|/]\s*$/;
const SEP_START = /^\s*[-–—·|/]\s*/;
const SEP_WORD = /^[-–—·|/]$/;

/** Rule 1: the longest tail kept whole; a name at most this long is never split. */
export const NAME_TAIL_MAX = 28;
/** Rule 1: the tail may be this long when the name is told apart by that segment alone. */
export const NAME_TAIL_DIFF_MAX = 40;
/** Rule 3: a tail paired with a kept start grows back to its segment's start up to this length. */
export const NAME_TAIL_SEGMENT_MAX = 20;
/** Rule 1: a visible cut head under this many characters is dropped ("… tail"). */
export const NAME_HEAD_MIN = 8;
/** Rule 2: the shared prefix and what each row keeps after it are at least this long. */
const PREFIX_MIN = 12;

/**
 * `head` is the part that gets cut; `tail` stays. `head` never ends in a space and, when there is a head,
 * `tail` starts with exactly one space, so a cut head reads "head… tail".
 * `shared`: the head is the set's shared start (rule 2), printed muted or dropped.
 * `pre`: the start kept before the cut part (rule 3). `head2` + `tail2`: the two-line form (rule 3).
 */
export interface NameSplit {
    head: string;
    tail: string;
    shared: boolean;
    pre?: string;
    head2?: string;
    tail2?: string;
}

/** The fields the name rules read from a sensor. */
export interface NamedSensor {
    tag: string;
    description?: string;
}

/** The name every rule works on: the description, or the tag when there is none. */
export function displayedName(info: NamedSensor): string {
    return info.description || info.tag;
}

/** Rule 3b: true when two names differ only in case, spaces and punctuation ("SegmentNo 1" = "Segment No 1").
 *  Combining marks count as letters, so Thai names that differ only in a vowel or tone mark stay different. */
export function sameNameLoosely(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
    const na = norm(a);
    return na !== '' && na === norm(b);
}

const whole = (name: string): NameSplit => ({ head: '', tail: name, shared: false });

function at(name: string, cut: number, shared = false): NameSplit {
    const head = name.slice(0, cut).trimEnd();
    const rest = name.slice(cut).trimStart();
    if (!head || !rest) return whole(name);
    return { head, tail: ' ' + rest, shared };
}

function segStarts(name: string): number[] {
    const out: number[] = [];
    for (const m of name.matchAll(SEP)) out.push((m.index ?? 0) + m[0].length);
    return out;
}

/**
 * Rule 1 for one label. With a `prefix` shared by the set: head = the prefix + the name's own separator,
 * tail = the rest. Otherwise the tail is the longest run of trailing segments ≤ 28 characters; a name with
 * no separator keeps its trailing whole words instead. A name ≤ 28 characters or with no spaces is never
 * split (it end-cuts).
 */
export function splitName(name: string, prefix?: string): NameSplit {
    if (prefix && name.startsWith(prefix) && name.length - prefix.length >= 2) {
        const sep = SEP_START.exec(name.slice(prefix.length));
        return at(name, prefix.length + (sep ? sep[0].length : 0), true);
    }
    if (name.length <= NAME_TAIL_MAX) return whole(name);
    const seps = segStarts(name);
    for (const i of seps) if (name.length - i <= NAME_TAIL_MAX) return at(name, i);
    if (!seps.length) {
        for (const m of name.matchAll(/ (?=\S)/g)) {
            const i = (m.index ?? 0) + 1;
            if (i >= 2 && name.length - i <= NAME_TAIL_MAX) return at(name, i);
        }
    }
    return whole(name);
}

/**
 * What is worked out once per names array, because a group can hold thousands of names and every row reads all of
 * them. Keyed by the array itself, so a names array must not be changed in place after its first use (every caller
 * builds a new one in a `useMemo`).
 */
interface NameSetCache {
    /** Every name split into words; built on first need. */
    others: { name: string; words: string[] }[] | null;
    /** prefix ('' = none) → name → split. Keyed by prefix because the prefix changes the result. */
    splits: Map<string, Map<string, NameSplit>>;
    /** prefix → the names with it removed (`namesAfterPrefix`). */
    after: Map<string, readonly string[]>;
}
const nameSetCaches = new WeakMap<readonly string[], NameSetCache>();

function nameSetCache(names: readonly string[]): NameSetCache {
    let cache = nameSetCaches.get(names);
    if (!cache) {
        cache = { others: null, splits: new Map(), after: new Map() };
        nameSetCaches.set(names, cache);
    }
    return cache;
}

/**
 * Rule 3 for a label inside a set (list, chips, picker group, tooltip, "X vs Y"): the visible text reads
 * differently from every other name in `names`. Keeps `pre` (up to the first word that differs from a row
 * sharing its end) and `tail` (from the last word that differs from a row sharing its start), taking the
 * shortest pair that tells it apart. Add sensors printed on the same card (a model target) to `names`.
 * Results are cached per `names` array: keep the array stable across rows and renders.
 */
export function splitInSet(name: string, names: readonly string[], prefix?: string): NameSplit {
    const sp = splitName(name, prefix);
    if (!names.length || sp.shared || name.length <= NAME_TAIL_MAX) return sp;
    const cache = nameSetCache(names);
    const key = prefix ?? '';
    let byName = cache.splits.get(key);
    if (!byName) {
        byName = new Map();
        cache.splits.set(key, byName);
    }
    let out = byName.get(name);
    if (!out) {
        cache.others ??= names.filter(Boolean).map(n => ({ name: n, words: n.split(/\s+/).filter(Boolean) }));
        out = splitAgainst(name, sp, cache.others);
        byName.set(name, out);
    }
    return out;
}

function splitAgainst(name: string, sp: NameSplit, others: NonNullable<NameSetCache['others']>): NameSplit {
    const W = [...name.matchAll(/\S+/g)].map(m => ({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length, w: m[0] }));
    const L = W.length;
    if (L < 3) return sp;
    const ws = W.map(x => x.w);
    const cons: { p: number; q: number }[] = [];
    const seen = new Set<number>();
    for (const { name: o, words: ow } of others) {
        if (o === name) continue;
        let p = 0;
        while (p < L && p < ow.length && ws[p] === ow[p]) p++;
        if (p >= L && ow.length === L) continue;
        let k = 0;
        while (k < L && k < ow.length && ws[L - 1 - k] === ow[ow.length - 1 - k]) k++;
        const con = { p: Math.min(p, L - 1), q: Math.max(0, L - 1 - k) };
        const id = con.p * L + con.q;
        if (!seen.has(id)) {
            seen.add(id);
            cons.push(con);
        }
    }
    if (!cons.length) return sp;
    const isSep = (i: number) => SEP_WORD.test(ws[i]);
    let best: { h: number; t: number; cost: number; tailLen: number } | null = null;
    for (let h = -1; h < L; h++) {
        if (h >= 0 && isSep(h)) continue;
        let t = L;
        for (const c of cons) if (c.p > h) t = Math.min(t, c.q);
        if (t <= h) continue;
        const preLen = h >= 0 ? W[h].e : 0;
        const tailLen = t < L ? name.length - W[t].s : 0;
        const cost = preLen + tailLen;
        if (!best || cost < best.cost || (cost === best.cost && tailLen < best.tailLen)) best = { h, t, cost, tailLen };
    }
    if (!best) return whole(name);
    const { h } = best;
    let { t } = best;
    // No tail is needed to tell it apart: keep rule 1's end (or its last word) as the tail.
    const tailNeeded = t < L;
    if (!tailNeeded) {
        const r1 = sp.head ? name.length - sp.tail.trimStart().length : W[L - 1].s;
        t = W.findIndex(x => x.s >= r1);
        if (t < 0) t = L - 1;
    }
    while (t < L && isSep(t)) t++;
    if (t >= L || t <= h + 1) return whole(name);
    const preEnd = h >= 0 ? W[h].e : 0;
    let tailStart = W[t].s;
    let seg = 0;
    for (const st of segStarts(name)) if (st <= tailStart) seg = st;
    // The end starts at its segment's start when that is short. A tail with no kept start carries the whole
    // difference, so it may reach 40 characters rather than read as a bare last word ("… A").
    const segMax = preEnd === 0 && tailNeeded ? NAME_TAIL_DIFF_MAX : NAME_TAIL_SEGMENT_MAX;
    if (seg > preEnd && name.length - seg <= segMax) tailStart = seg;
    const mid = name.slice(preEnd, tailStart).trimEnd();
    if (!mid.trim()) return whole(name);
    // Two-line form: line 2 has a whole line, so it starts at the segment's start.
    let t2 = seg > preEnd ? Math.min(seg, tailStart) : tailStart;
    const r1 = sp.head ? name.length - sp.tail.trimStart().length : -1;
    if (r1 > preEnd && r1 < t2) t2 = r1;
    return {
        pre: name.slice(0, preEnd),
        head: mid,
        tail: ' ' + name.slice(tailStart),
        shared: false,
        head2: name.slice(preEnd, t2).trimEnd(),
        tail2: name.slice(t2),
    };
}

/** The shortest text a split may print: "pre … tail" or "… tail"; the name itself when it has no head. */
export function compactName(sp: NameSplit): string {
    if (!sp.head) return (sp.pre ?? '') + sp.tail;
    const pre = sp.pre ?? '';
    return `${pre}${pre ? ' … ' : '… '}${sp.tail.trimStart()}`;
}

/**
 * Rule 3 "the tail grows back": the compact text with 0, 1, 2… more words pulled back into the tail, as far
 * as the kept start. `starts[k - 1]` is where the tail starts in form k (use with `withWiderTail`).
 */
export function widerTailForms(sp: NameSplit): { forms: string[]; starts: number[] } {
    const pre = sp.pre ?? '';
    const full = pre + sp.head + sp.tail;
    const tailAt = full.length - sp.tail.trimStart().length;
    const starts: number[] = [];
    if (!sp.shared && sp.head) {
        for (const m of full.slice(pre.length, tailAt).matchAll(/\S+/g)) {
            const i = pre.length + (m.index ?? 0);
            if (i > pre.length && !SEP_WORD.test(m[0])) starts.unshift(i);
        }
    }
    const lead = pre ? `${pre} … ` : '… ';
    return { forms: [compactName(sp), ...starts.map(i => lead + full.slice(i))], starts };
}

/** The split that prints form `k` of `widerTailForms` (k = 0: the split itself). */
export function withWiderTail(sp: NameSplit, starts: readonly number[], k: number): NameSplit {
    if (k <= 0 || k > starts.length) return sp;
    const pre = sp.pre ?? '';
    const full = pre + sp.head + sp.tail;
    const i = starts[k - 1];
    return { ...sp, head: full.slice(pre.length, i).trimEnd(), tail: ' ' + full.slice(i) };
}

/**
 * Rule 2: the start every name of a set shares, cut back to a segment boundary, without its separator.
 * '' when there is none worth printing: under 2 names, every name ≤ 28 characters, a prefix under 12
 * characters, or a name that would keep under 12 characters after it. Whether it is PRINTED depends on a
 * row actually being cut (`useCutRuns`).
 */
export function commonPrefix(names: readonly string[]): string {
    const list = names.filter(Boolean);
    if (list.length < 2) return '';
    if (Math.max(...list.map(n => n.length)) <= NAME_TAIL_MAX) return '';
    let p = list[0];
    for (const n of list) {
        let i = 0;
        while (i < p.length && i < n.length && p[i] === n[i]) i++;
        p = p.slice(0, i);
        if (!p) return '';
    }
    const ends = segStarts(p);
    for (let i = ends.length - 1; i >= 0; i--) {
        const cand = p.slice(0, ends[i]).replace(SEP_END, '');
        if (list.every(n => n.length - cand.length >= PREFIX_MIN)) return cand.length >= PREFIX_MIN ? cand : '';
    }
    return '';
}

/** Rule 2 for a set where most names share a start: the prefix of the names in the same family as
 *  `names[0]` (same first segment), '' when fewer than two are in it. */
export function familyPrefix(names: readonly string[]): string {
    const list = names.filter(Boolean);
    if (list.length < 2) return '';
    const firstSegment = (n: string) => n.split(/\s[-–—·|/]\s/)[0];
    const first = firstSegment(list[0]);
    const family = list.filter(n => firstSegment(n) === first);
    return family.length >= 2 ? commonPrefix(family) : '';
}

/** What a row prints under a shared `prefix`: the name without the prefix and its separator. */
export function afterPrefix(name: string, prefix: string): string {
    return prefix && name.startsWith(prefix) ? name.slice(prefix.length).replace(SEP_START, '') : name;
}

/** `afterPrefix` over a whole set, one array per names + prefix: rows of a set share it, so `splitInSet`'s cache
 *  works for them too. A new array per row would pay for every name, per row. */
export function namesAfterPrefix(names: readonly string[], prefix: string): readonly string[] {
    const { after } = nameSetCache(names);
    let out = after.get(prefix);
    if (!out) {
        out = names.map(n => afterPrefix(n, prefix));
        after.set(prefix, out);
    }
    return out;
}

/**
 * Rule 1 for an export model key `<sanitized tag>-<R|I|C><n>` + extension: the same 28-character tail, cut
 * at a sanitized " - " (`_-_`), then at `_`. The `-R1` and the extension always stay. A key with no such
 * boundary end-cuts (head '').
 */
export function splitKey(key: string, ext = ''): { head: string; tail: string } {
    const m = /^(.*)(-[RIC]\d+)$/.exec(key);
    const base = m ? m[1] : key;
    const suffix = (m ? m[2] : '') + ext;
    if (base.length <= NAME_TAIL_MAX) return { head: '', tail: base + suffix };
    let cut = -1;
    for (let i = base.indexOf('_-_'); i >= 0; i = base.indexOf('_-_', i + 1)) {
        if (base.length - (i + 3) <= NAME_TAIL_MAX) { cut = i + 3; break; }
    }
    if (cut < 0) {
        for (let i = base.indexOf('_'); i >= 0; i = base.indexOf('_', i + 1)) {
            if (base.length - (i + 1) <= NAME_TAIL_MAX && i + 1 >= NAME_HEAD_MIN) { cut = i + 1; break; }
        }
    }
    if (cut < 0) return { head: '', tail: base + suffix };
    return { head: base.slice(0, cut), tail: base.slice(cut) + suffix };
}
