import { AlertTriangle, CheckCircle } from "lucide-react";
import type { CsvLoadReport } from "../../types/dataUpload";

export default function DataValidationSummary({ report }: { report: CsvLoadReport }) {
  return (
    <section className="flex flex-col gap-3 mt-4">
      <div className="flex items-center gap-2 mb-1">
        <CheckCircle size={18} className="text-emerald-400" />
        <h2 className="text-sm font-semibold tracking-wide text-neutral-200">
          Validation Summary
        </h2>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 rounded-lg bg-neutral-800/50 border border-neutral-700/40 px-3 py-2 text-center">
          <div className="text-lg font-bold text-neutral-100">
            {report.columns.length}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            Columns
          </div>
        </div>
        <div className="flex-1 rounded-lg bg-neutral-800/50 border border-neutral-700/40 px-3 py-2 text-center">
          <div className="text-lg font-bold text-neutral-100">
            {report.total_rows.toLocaleString()}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            Rows
          </div>
        </div>
      </div>

      {report.warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          {report.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg bg-amber-950/30 border border-amber-700/30 px-3 py-2 text-xs text-amber-300"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-neutral-700/40 overflow-hidden max-h-56 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-neutral-800/80 sticky top-0">
            <tr>
              <th className="text-left px-3 py-2 text-neutral-400 font-medium">Name</th>
              <th className="text-left px-3 py-2 text-neutral-400 font-medium">Type</th>
              <th className="text-right px-3 py-2 text-neutral-400 font-medium">Nulls</th>
              <th className="text-right px-3 py-2 text-neutral-400 font-medium">Valid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {report.columns.map((col) => (
              <tr key={col.name} className="hover:bg-neutral-800/40 transition-colors">
                <td className="px-3 py-1.5 text-neutral-200 truncate max-w-[180px]">{col.name}</td>
                <td className="px-3 py-1.5 text-neutral-400">{col.dtype}</td>
                <td className="px-3 py-1.5 text-right text-neutral-400">
                  {col.null_count > 0 ? (
                    <span className="text-amber-400">{col.null_count.toLocaleString()}</span>
                  ) : "0"}
                </td>
                <td className="px-3 py-1.5 text-right text-neutral-400">{col.valid_count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
