import { CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import type { MappingResult } from "../../types/dataUpload";

export default function MappingResults({ result }: { result: MappingResult }) {
  return (
    <section className="flex flex-col gap-3 mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
        Mapping Results
      </h3>

      {result.matched.length > 0 && (
        <div className="rounded-lg bg-emerald-950/30 border border-emerald-700/30 p-3">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold">
            <CheckCircle size={14} />
            <span>
              {result.matched.length} column{result.matched.length !== 1 ? "s" : ""}{" "}
              matched
            </span>
          </div>
        </div>
      )}

      {result.not_in_dataset.length > 0 && (
        <div className="rounded-lg bg-amber-950/30 border border-amber-700/30 p-3">
          <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold mb-2">
            <AlertTriangle size={14} />
            <span>
              {result.not_in_dataset.length} key{result.not_in_dataset.length !== 1 ? "s" : ""}{" "}
              in mapping but not in dataset
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {result.not_in_dataset.map((col) => (
              <div key={col} className="text-[11px] text-amber-300/70 truncate">{col}</div>
            ))}
          </div>
        </div>
      )}

      {result.not_in_mapping.length > 0 && (
        <div className="rounded-lg bg-red-950/30 border border-red-700/30 p-3">
          <div className="flex items-center gap-2 text-red-400 text-xs font-semibold mb-2">
            <XCircle size={14} />
            <span>
              {result.not_in_mapping.length} dataset column{result.not_in_mapping.length !== 1 ? "s" : ""}{" "}
              not found in mapping
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {result.not_in_mapping.map((col) => (
              <div key={col} className="text-[11px] text-red-300/70 truncate">{col}</div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
