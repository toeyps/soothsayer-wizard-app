import { Loader2 } from "lucide-react";

interface SensorTagMappingProps {
  headers: string[];
  keyColumn: string | null;
  isLoading: boolean;
  onSetKeyColumn: (col: string) => void;
  onApply: () => void;
}

export default function SensorTagMapping({
  headers,
  keyColumn,
  isLoading,
  onSetKeyColumn,
  onApply,
}: SensorTagMappingProps) {
  return (
    <section className="flex flex-col gap-3 mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
        Column Mapping
      </h3>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-neutral-500">Key Column</span>
        <select
          value={keyColumn ?? ""}
          onChange={(e) => onSetKeyColumn(e.target.value)}
          className="rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs px-3 py-2 focus:outline-none focus:border-violet-500 transition-colors"
        >
          <option value="" disabled>Select column...</option>
          {headers.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={onApply}
        disabled={!keyColumn || isLoading}
        className="flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {isLoading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Applying...
          </>
        ) : (
          "Apply Mapping"
        )}
      </button>
    </section>
  );
}
