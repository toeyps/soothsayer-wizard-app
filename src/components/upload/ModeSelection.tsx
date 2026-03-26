import { Crosshair, BrainCircuit } from "lucide-react";

export type SelectedMode = "free_exploration" | "soothsayer" | null;

interface ModeSelectionProps {
  selectedMode: SelectedMode;
  onSelect: (mode: "free_exploration" | "soothsayer") => void;
  disabled: boolean;
}

export default function ModeSelection({
  selectedMode,
  onSelect,
  disabled,
}: ModeSelectionProps) {
  return (
    <section className="flex gap-4 w-full">
      <button
        type="button"
        onClick={() => onSelect("free_exploration")}
        disabled={disabled}
        className={`flex-1 flex flex-col items-center gap-2 rounded-2xl border-2 py-5 px-4 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
          selectedMode === "free_exploration"
            ? "border-sky-500 bg-sky-950/40 text-sky-300"
            : "border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        }`}
      >
        <Crosshair size={28} />
        <span className="text-sm font-bold">Free Exploration Mode</span>
        <span className="text-[11px] opacity-60 text-center leading-snug">
          Explore sensor data freely with charts and filters
        </span>
      </button>

      <button
        type="button"
        onClick={() => onSelect("soothsayer")}
        disabled={disabled}
        className={`flex-1 flex flex-col items-center gap-2 rounded-2xl border-2 py-5 px-4 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
          selectedMode === "soothsayer"
            ? "border-violet-500 bg-violet-950/40 text-violet-300"
            : "border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        }`}
      >
        <BrainCircuit size={28} />
        <span className="text-sm font-bold">Soothsayer Predictive Mode</span>
        <span className="text-[11px] opacity-60 text-center leading-snug">
          Build predictive models with failure group analysis
        </span>
      </button>
    </section>
  );
}
