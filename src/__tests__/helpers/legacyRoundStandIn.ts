import { convertExcelRoundCall } from '../../utils/formulaRounding';
import { excelRoundCalls } from '../../utils/formulaTokens';

/** Stands in for Rust's `convert_legacy_round` in tests: every convertible
 *  spreadsheet-order call rewritten, right to left (nested calls included). */
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
