import { roundExpression } from '../../utils/formulaRounding';
import { excelRoundCalls, tokenizeFormula, type ExcelRoundCall } from '../../utils/formulaTokens';

/** Stand-in for Rust's `convert_legacy_round`: rewrites every convertible spreadsheet-order call, right to left (nested included). */
export function convertLegacyRoundStandIn(text: string): string {
    let out = text;
    const starts = excelRoundCalls(text).map(c => c.start);
    for (const start of [...starts].reverse()) {
        const call = excelRoundCalls(out).find(c => c.start === start);
        if (!call) continue;
        const rep = convertCall(out, call);
        if (rep === null) continue;
        out = out.slice(0, call.start) + rep + out.slice(call.end);
    }
    return out;
}

/** A plain whole `n` in 0..=15, else null (Rust `round_places`). */
function places(n: string): number | null {
    const t = n.trim();
    if (!/^\d+(\.0*)?$/.test(t)) return null;
    const v = Number(t);
    return Number.isInteger(v) && v >= 0 && v <= 15 ? v : null;
}

function convertCall(text: string, call: ExcelRoundCall): string | null {
    const p = places(text.slice(call.n[0], call.n[1]));
    if (p === null) return null;
    const x = text.slice(call.x[0], call.x[1]).trim();
    if (p === 0) return `round(${x})`;
    const core = roundExpression(x, p);
    return standsAlone(text, call.start, call.end) ? core : `(${core})`;
}

/** Rust's `stands_alone`: can `round(…) / k` replace `[start, end)` without brackets? */
function standsAlone(text: string, start: number, end: number): boolean {
    const refs = tokenizeFormula(text).filter(t => t.kind === 'sensor').map(t => [t.start, t.end] as [number, number]);
    const inRef = (i: number) => refs.some(([a, b]) => i >= a && i < b);
    const ws = (i: number) => /\s/u.test(text[i]);
    const prevIdx = (from: number) => { for (let i = from - 1; i >= 0; i--) if (inRef(i) || !ws(i)) return i; return -1; };
    const nextIdx = (from: number) => { for (let i = from; i < text.length; i++) if (inRef(i) || !ws(i)) return i; return -1; };
    const valueEnd = (i: number) => inRef(i) || /[A-Za-z0-9_.)\]]/.test(text[i]);
    const p = prevIdx(start);
    let prevOk: boolean;
    if (p < 0) prevOk = true;
    else if (inRef(p)) prevOk = false;
    else if ('([,;'.includes(text[p])) prevOk = true;
    else if (text[p] === '+' || text[p] === '-') { const q = prevIdx(p); prevOk = q >= 0 && valueEnd(q); }
    else prevOk = false;
    const n = nextIdx(end);
    const nextOk = n < 0 || (!inRef(n) && ')],;+-*/'.includes(text[n]));
    return prevOk && nextOk;
}
