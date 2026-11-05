import { convertExcelRoundCall } from '../../utils/formulaRounding';
import { excelRoundCalls } from '../../utils/formulaTokens';

/** Stand-in for Rust's `convert_legacy_round`: rewrites every convertible spreadsheet-order call, right to left (nested included). */
export function convertLegacyRoundStandIn(text: string): string {
    let out = text;
    const starts = excelRoundCalls(text).map(c => c.start);
    for (const start of [...starts].reverse()) {
        const call = excelRoundCalls(out).find(c => c.start === start);
        if (!call) continue;
        const rep = convertExcelRoundCall(out, call);
        if (rep === null) continue;
        out = out.slice(0, call.start) + rep + out.slice(call.end);
    }
    return out;
}
