import { Upload, FileText, AlertTriangle, Loader2, FileSpreadsheet } from "lucide-react";
import type { MappingData } from "../../types/dataUpload";

interface MappingUploadProps {
  mappingData: MappingData | null;
  mappingFilePath: string | null;
  isLoading: boolean;
  error: string | null;
  onSelectFile: () => void;
}

export default function MappingUpload({
  mappingData,
  mappingFilePath,
  isLoading,
  error,
  onSelectFile,
}: MappingUploadProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 mb-1">
        <FileSpreadsheet size={18} className="text-violet-400" />
        <h2 className="text-sm font-semibold tracking-wide text-neutral-200">
          Sensor Mapping File
        </h2>
      </div>

      <button
        type="button"
        onClick={onSelectFile}
        disabled={isLoading}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-600 hover:border-violet-500 bg-neutral-800/40 hover:bg-neutral-800/70 text-neutral-400 hover:text-neutral-200 transition-colors py-5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Upload size={18} />
        <span className="text-sm font-medium">
          {mappingFilePath ? "Replace Mapping CSV" : "Select Mapping CSV"}
        </span>
      </button>

      {mappingFilePath && (
        <div className="flex items-center gap-2 text-xs text-violet-300/80 bg-violet-950/30 border border-violet-800/30 rounded-lg px-3 py-2">
          <FileText size={13} className="shrink-0" />
          <span className="truncate">{mappingFilePath.split(/[/\\]/).pop()}</span>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center gap-2 text-neutral-400 text-xs py-2">
          <Loader2 size={14} className="animate-spin" />
          Loading mapping data...
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs bg-red-950/30 border border-red-800/30 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {mappingData && (
        <div className="rounded-lg border border-neutral-700/40 overflow-auto max-h-48">
          <table className="text-xs min-w-max">
            <thead className="bg-neutral-800/80 sticky top-0">
              <tr>
                {mappingData.headers.map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-neutral-400 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {mappingData.rows.slice(0, 50).map((row, ri) => (
                <tr key={ri} className="hover:bg-neutral-800/40 transition-colors">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5 text-neutral-300 whitespace-nowrap">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {mappingData.rows.length > 50 && (
            <div className="text-[10px] text-neutral-500 text-center py-1 bg-neutral-800/60">
              Showing 50 of {mappingData.rows.length} rows
            </div>
          )}
        </div>
      )}
    </section>
  );
}
