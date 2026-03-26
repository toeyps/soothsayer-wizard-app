import {
  Upload,
  X,
  FileText,
  AlertTriangle,
  Loader2,
  Info,
  Database,
} from "lucide-react";

interface DatasetUploadProps {
  selectedFiles: string[];
  isLoading: boolean;
  error: string | null;
  onSelectFiles: () => void;
  onRemoveFile: (path: string) => void;
  onUpload: () => void;
}

export default function DatasetUpload({
  selectedFiles,
  isLoading,
  error,
  onSelectFiles,
  onRemoveFile,
  onUpload,
}: DatasetUploadProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 mb-1">
        <Database size={18} className="text-sky-400" />
        <h2 className="text-sm font-semibold tracking-wide text-neutral-200">
          Dataset Files
        </h2>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-sky-950/40 border border-sky-800/30 px-3 py-2 text-xs text-sky-300/80 leading-relaxed">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          First column must be a datetime index. No duplicate column names.
          All files share the same datetime column.
        </span>
      </div>

      <button
        type="button"
        onClick={onSelectFiles}
        disabled={isLoading}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-600 hover:border-sky-500 bg-neutral-800/40 hover:bg-neutral-800/70 text-neutral-400 hover:text-neutral-200 transition-colors py-6 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Upload size={20} />
        <span className="text-sm font-medium">Select CSV Files</span>
      </button>

      {selectedFiles.length > 0 && (
        <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1">
          {selectedFiles.map((path) => {
            const fileName = path.split(/[/\\]/).pop() ?? path;
            return (
              <div
                key={path}
                className="flex items-center justify-between gap-2 rounded-lg bg-neutral-800/60 border border-neutral-700/50 px-3 py-2"
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <FileText size={14} className="text-neutral-500 shrink-0" />
                  <span className="text-xs text-neutral-300 truncate">
                    {fileName}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveFile(path)}
                  className="text-neutral-500 hover:text-red-400 transition-colors shrink-0 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={onUpload}
        disabled={selectedFiles.length === 0 || isLoading}
        className="flex items-center justify-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {isLoading ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Processing...
          </>
        ) : (
          "Process Files"
        )}
      </button>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs bg-red-950/30 border border-red-800/30 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
