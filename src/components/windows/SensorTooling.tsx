import { useState, useEffect, useRef } from "react";
import { SensorOperationConfig, SensorMetadata } from "../../types";
import { useCalculationEngine, FORMULA_MULTI_IDS } from "../../hooks/useCalculationEngine";
import type { UseCalculationEngineReturn } from "../../hooks/useCalculationEngine";
import { useFormulaEditor } from "../../hooks/useFormulaEditor";
import { findOperation } from "../../config/operations";
import {
  Star,
  ChevronDown,
  ChevronRight,
  HelpCircle,
} from "lucide-react";

interface SensorToolingProps {
  selectedSensors: string[];
  sensorMetadata: SensorMetadata[] | null;
  onConfigChange: (config: SensorOperationConfig | null) => void;
  onRemoveSensor: (sensor: string) => void;
  // Formula mode submission callback
  onFormulaSubmit?: (formula: string, customName?: string) => void;
  // Master-data fields (description/unit/component) -- purely metadata for
  // the new sensor, unrelated to the calculation itself, so none of these
  // are part of useCalculationEngine. Each fires on every keystroke;
  // AddSensorWindow reads the latest values when it actually creates the
  // sensor. "Name" (the sensor's tag/column header) is still `engine.customName`,
  // required and requested inline in the same section.
  onDescriptionChange?: (description: string) => void;
  onUnitChange?: (unit: string) => void;
  onComponentChange?: (component: string) => void;
}

const NUMBER_OP_IDS = ["add", "subtract", "multiply", "divide", "power"];
const TRANSFORM_OP_IDS = ["abs", "sqrt", "log10", "exp", "ceil", "floor", "round"];
const AGG_OP_IDS = ["sum", "mean", "median", "product", "temp_spread", "abs_diff"];
const BASE_OP_IDS = ["subtract", "divide", "efficiency_pct"];
const WRAP_OP_IDS = ["abs", "sqrt", "log10", "exp", "ceil", "floor", "round"];
const CHAIN_OPERATORS = [
  { symbol: "+", label: "Add" },
  { symbol: "−", label: "Subtract" },
  { symbol: "×", label: "Multiply" },
  { symbol: "÷", label: "Divide" },
];
/** Multi-sensor ops that only make sense for exactly two sensors. */
const PAIRWISE_ONLY_IDS = new Set(["abs_diff", "efficiency_pct"]);

export default function SensorTooling({
  selectedSensors,
  sensorMetadata,
  onConfigChange,
  onRemoveSensor,
  onFormulaSubmit,
  onDescriptionChange,
  onUnitChange,
  onComponentChange,
}: SensorToolingProps) {
  const engine = useCalculationEngine(selectedSensors);
  // Autocomplete suggests ONLY the checked sensors so users can't reference
  // sensors they haven't pulled into the Target Sensors panel.
  const formulaEditor = useFormulaEditor(selectedSensors);

  const [showSyntaxHelp, setShowSyntaxHelp] = useState(false);
  const [openChainDropdown, setOpenChainDropdown] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [component, setComponent] = useState("");

  // Reset the chosen operation whenever the sensor selection itself
  // changes, so an operation picked for a different set of sensors can't
  // silently carry over (e.g. a "starting value" that's no longer selected).
  const prevSelectionKey = useRef(selectedSensors.join("|"));
  useEffect(() => {
    const key = selectedSensors.join("|");
    if (key !== prevSelectionKey.current) {
      prevSelectionKey.current = key;
      engine.setOperationId(null);
      engine.setWrapFunc(null);
      setDescription("");
      setUnit("");
      setComponent("");
      onDescriptionChange?.("");
      onUnitChange?.("");
      onComponentChange?.("");
    }
  }, [selectedSensors, engine.setOperationId, engine.setWrapFunc, onDescriptionChange, onUnitChange, onComponentChange]);

  const buildResult = engine.build();

  // Whether "Add sensor" would actually create a new derived sensor (vs.
  // just adding the selected sensor(s) through as-is) -- gates the
  // Name/Description/Unit/Component fields below, since there's nothing to
  // name otherwise.
  const creatingSomething =
    engine.mode === "formula" ? formulaEditor.formula.trim() !== "" : buildResult.kind !== "none";

  const existingComponents = Array.from(
    new Set((sensorMetadata ?? []).map((m) => m.component).filter((c): c is string => !!c))
  ).sort();

  // Notify parent of the resolved calculation. A "legacy" result routes
  // through `calculate_new_sensor`; a "none" result (only reachable with 0
  // or 1 sensor selected) means "add the sensor as-is" -- 2+ sensors always
  // resolve to at least the default operator chain, never "none".
  useEffect(() => {
    onConfigChange(buildResult.kind === "legacy" ? buildResult.config : null);
  }, [buildResult, onConfigChange]);

  // A "formula" result (the operator chain, a named formula shortcut, a
  // "then apply to the result" wrap, or manually-typed text) all route
  // through the same `evaluate_formula` path as "Edit as text instead".
  useEffect(() => {
    if (!onFormulaSubmit) return;
    if (engine.mode === "formula") {
      onFormulaSubmit(formulaEditor.formula, engine.customName || undefined);
    } else if (buildResult.kind === "formula") {
      onFormulaSubmit(buildResult.expression, engine.customName || undefined);
    }
  }, [engine.mode, buildResult, formulaEditor.formula, engine.customName, onFormulaSubmit]);

  const getSensorName = (tag: string) => {
    const meta = sensorMetadata?.find((m) => m.tag === tag);
    return meta ? meta.description || tag : tag;
  };

  const pickingBase = engine.opGroup === "multi" && BASE_OP_IDS.includes(engine.operationId ?? "");

  return (
    <div className="flex flex-col h-full bg-[var(--bg-secondary)] overflow-hidden">
      <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-4">
        {/* Target Sensors */}
        <div>
          <h3 className="text-xs font-bold uppercase text-[var(--text-secondary)] mb-2">
            Target Sensors
          </h3>
          <div className="text-sm bg-[var(--input-bg)] p-2 rounded border border-[var(--border)] max-h-24 overflow-y-auto">
            {selectedSensors.length === 0 ? (
              <span className="text-[var(--text-secondary)] italic">
                No sensors selected
              </span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {selectedSensors.map((s) => {
                  const isBase = pickingBase && (engine.baseSensor || selectedSensors[0]) === s;
                  return (
                    <span
                      key={s}
                      onClick={pickingBase ? () => engine.setBaseSensor(s) : undefined}
                      className="px-2 py-0.5 rounded text-xs border flex items-center gap-1"
                      style={{
                        cursor: pickingBase ? "pointer" : "default",
                        backgroundColor: isBase ? "var(--accent-color)" : "var(--card-bg)",
                        color: isBase ? "white" : "var(--text-primary)",
                        borderColor: isBase ? "var(--accent-color)" : "var(--border)",
                      }}
                      title={pickingBase ? "Click to mark as the starting value" : undefined}
                    >
                      {isBase && <Star size={10} fill="currentColor" />}
                      {getSensorName(s)}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveSensor(s);
                        }}
                        className="hover:text-red-500 focus:outline-none"
                      >
                        &times;
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {pickingBase && (
            <p className="text-[10px] text-[var(--text-secondary)] mt-1">
              Click a sensor above to mark it as the starting value.
            </p>
          )}
        </div>

        {/* ============= BUTTON-DRIVEN OPERATIONS ============= */}
        {engine.mode === "buttons" && (
          <ButtonBuilder
            engine={engine}
            selectedSensors={selectedSensors}
            openChainDropdown={openChainDropdown}
            setOpenChainDropdown={setOpenChainDropdown}
            getSensorName={getSensorName}
          />
        )}

        {/* ============= FORMULA MODE ============= */}
        {engine.mode === "formula" && (
          <AdvancedMode
            formulaEditor={formulaEditor}
            showSyntaxHelp={showSyntaxHelp}
            setShowSyntaxHelp={setShowSyntaxHelp}
          />
        )}

        <button
          onClick={() => engine.setMode(engine.mode === "buttons" ? "formula" : "buttons")}
          className="self-start text-xs text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]"
        >
          {engine.mode === "buttons" ? "Edit as text instead" : "Use buttons instead"}
        </button>

        {/* Preview panel */}
        <div className="p-3 bg-[rgba(59,130,246,0.1)] border border-[var(--accent-color)] rounded text-xs text-[var(--text-primary)]">
          <span className="font-semibold text-[var(--accent-color)]">Preview:</span>
          <div className="mt-1">
            {selectedSensors.length > 0 ? (
              <div>
                {engine.customName && <span className="font-bold">{engine.customName} = </span>}
                {buildPreviewText(engine, selectedSensors, getSensorName, formulaEditor.formula)}
              </div>
            ) : (
              <div className="text-[var(--text-secondary)]">Select sensors to see a preview</div>
            )}
          </div>
        </div>

        {/* Name/Description/Unit/Component -- the same master-data fields a
            mapping CSV supplies for imported sensors -- only relevant once
            there's actually a new sensor about to be created; nothing to
            name when adding as-is. */}
        {creatingSomething && (
          <div className="flex flex-col gap-3 p-3 rounded bg-[var(--input-bg)]">
            <div>
              <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
                Name this sensor <span style={{ color: "var(--danger)" }}>*</span>
              </label>
              <input
                type="text"
                value={engine.customName}
                onChange={(e) => engine.setCustomName(e.target.value)}
                placeholder="e.g. Total Power"
                className="w-full bg-[var(--card-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
              />
              <p className="text-[10px] text-[var(--text-secondary)] mt-1">
                Becomes this sensor's tag. Also used as its description below unless you set one.
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  onDescriptionChange?.(e.target.value);
                }}
                placeholder={engine.customName || "e.g. Total boiler power draw"}
                className="w-full bg-[var(--card-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
                  Unit
                </label>
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => {
                    setUnit(e.target.value);
                    onUnitChange?.(e.target.value);
                  }}
                  placeholder="e.g. kW"
                  className="w-full bg-[var(--card-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
                  Component
                </label>
                <ComboBox
                  value={component}
                  onChange={(v) => {
                    setComponent(v);
                    onComponentChange?.(v);
                  }}
                  options={existingComponents}
                  placeholder="Pick or type"
                />
              </div>
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] -mt-1">
              Component groups this sensor with related ones in the Sensor tab. Leave blank for Uncategorized.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Button-driven operation builder -- what's offered depends only on how many
 * sensors are selected, so there's no separate mode to pick first.
 * ───────────────────────────────────────────────────────────────────────────── */

interface ButtonBuilderProps {
  engine: UseCalculationEngineReturn;
  selectedSensors: string[];
  openChainDropdown: number | null;
  setOpenChainDropdown: (i: number | null) => void;
  getSensorName: (tag: string) => string;
}

function ButtonBuilder({
  engine,
  selectedSensors,
  openChainDropdown,
  setOpenChainDropdown,
  getSensorName,
}: ButtonBuilderProps) {
  if (selectedSensors.length === 0) {
    return (
      <p className="text-xs text-[var(--text-secondary)]">
        Pick sensors on the left to get started.
      </p>
    );
  }

  if (selectedSensors.length === 1) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-[var(--text-secondary)]">
          Add this sensor as-is, or apply a calculation:
        </p>
        <OpGroup title="Combine with a number" ids={NUMBER_OP_IDS} engine={engine} />
        {NUMBER_OP_IDS.includes(engine.operationId ?? "") && (
          <ValueInput label="Value" engine={engine} />
        )}
        <OpGroup title="Transform" ids={TRANSFORM_OP_IDS} engine={engine} />
        {engine.operationId === "round" && (
          <ValueInput label="Decimal places" engine={engine} />
        )}
      </div>
    );
  }

  const aggIds = AGG_OP_IDS.filter(
    (id) => !PAIRWISE_ONLY_IDS.has(id) || selectedSensors.length === 2
  );
  const baseIds = BASE_OP_IDS.filter(
    (id) => !PAIRWISE_ONLY_IDS.has(id) || selectedSensors.length === 2
  );
  // Only formula-backed results (the chain, or a named formula shortcut)
  // can be wrapped -- a legacy `calculate_new_sensor` config has no
  // post-processing step, so wrapping it would silently do nothing.
  const chainActive = !engine.operationId;
  const canWrap = chainActive || FORMULA_MULTI_IDS.has(engine.operationId ?? "");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--text-secondary)]">
        {chainActive
          ? "Combining with + by default -- click a sign to change it, or pick a shortcut below:"
          : "Pick a sign between sensors, or use a shortcut below:"}
      </p>

      <ChainBuilder
        engine={engine}
        selectedSensors={selectedSensors}
        getSensorName={getSensorName}
        openIndex={openChainDropdown}
        setOpenIndex={setOpenChainDropdown}
      />

      <OpGroup title="Combine all" ids={aggIds} engine={engine} />
      <OpGroup title="Compare one against the rest" ids={baseIds} engine={engine} />

      {canWrap && <WrapGroup engine={engine} />}
    </div>
  );
}

function ChainBuilder({
  engine,
  selectedSensors,
  getSensorName,
  openIndex,
  setOpenIndex,
}: {
  engine: UseCalculationEngineReturn;
  selectedSensors: string[];
  getSensorName: (tag: string) => string;
  openIndex: number | null;
  setOpenIndex: (i: number | null) => void;
}) {
  // The chain is the default calculation whenever no "Combine all" /
  // "Compare one against the rest" shortcut is chosen -- not just after the
  // user has clicked an operator -- so its "active" styling must track that
  // same condition, not a separate touched-it-once flag.
  const chainActive = !engine.operationId;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-1">
        Combine with operators
      </div>
      <div
        className="flex flex-wrap items-center gap-1.5 p-2.5 rounded"
        style={{ backgroundColor: "var(--input-bg)" }}
      >
        {selectedSensors.map((tag, i) => (
          <span key={tag} className="contents">
            <span
              className="px-2 py-0.5 rounded text-xs"
              style={{ backgroundColor: "rgba(59,130,246,0.15)", color: "var(--accent-color)" }}
            >
              {getSensorName(tag)}
            </span>
            {i < selectedSensors.length - 1 && (
              <span className="relative">
                <button
                  onClick={() => setOpenIndex(openIndex === i ? null : i)}
                  className="min-w-[26px] px-2 py-0.5 rounded text-xs font-semibold border"
                  style={{
                    borderColor: chainActive ? "var(--accent-color)" : "var(--border)",
                    color: chainActive ? "var(--accent-color)" : "var(--text-primary)",
                    backgroundColor: "var(--card-bg)",
                  }}
                >
                  {engine.chainOps[i] ?? "+"}
                </button>
                {openIndex === i && (
                  <div
                    className="absolute z-50 mt-1 rounded border shadow-lg overflow-hidden"
                    style={{
                      backgroundColor: "var(--card-bg)",
                      borderColor: "var(--border)",
                      minWidth: "140px",
                    }}
                  >
                    {CHAIN_OPERATORS.map((op) => (
                      <button
                        key={op.symbol}
                        onClick={() => {
                          engine.setChainOp(i, op.symbol);
                          setOpenIndex(null);
                        }}
                        className="block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--hover-bg)] text-[var(--text-primary)]"
                      >
                        {op.label} ({op.symbol})
                      </button>
                    ))}
                  </div>
                )}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function WrapGroup({ engine }: { engine: UseCalculationEngineReturn }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-1">
          Then apply to the result
        </div>
        <div className="flex flex-wrap gap-1.5">
          {WRAP_OP_IDS.map((id) => {
            const op = findOperation("single", id);
            if (!op) return null;
            const active = engine.wrapFunc === id;
            return (
              <button
                key={id}
                onClick={() => engine.setWrapFunc(active ? null : id)}
                className="px-2.5 py-1 rounded text-xs border transition-colors"
                style={{
                  borderColor: active ? "var(--accent-color)" : "var(--border)",
                  backgroundColor: active ? "rgba(59,130,246,0.15)" : "var(--input-bg)",
                  color: active ? "var(--accent-color)" : "var(--text-primary)",
                }}
              >
                {op.label}
              </button>
            );
          })}
        </div>
      </div>
      {engine.wrapFunc === "round" && (
        <div className="flex items-center gap-2">
          <label className="text-xs font-bold uppercase text-[var(--text-secondary)]">
            Decimal places
          </label>
          <input
            type="number"
            value={engine.wrapValue}
            onChange={(e) => engine.setWrapValue(parseFloat(e.target.value) || 0)}
            className="w-24 bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-1.5 text-sm focus:outline-none focus:border-[var(--accent-color)]"
          />
        </div>
      )}
    </div>
  );
}

function OpGroup({ title, ids, engine }: { title: string; ids: string[]; engine: UseCalculationEngineReturn }) {
  if (ids.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-1">
        {title}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const op = findOperation(engine.opGroup, id);
          if (!op) return null;
          const active = engine.operationId === id;
          return (
            <button
              key={id}
              onClick={() => engine.setOperationId(active ? null : id)}
              className="px-2.5 py-1 rounded text-xs border transition-colors"
              style={{
                borderColor: active ? "var(--accent-color)" : "var(--border)",
                backgroundColor: active ? "rgba(59,130,246,0.15)" : "var(--input-bg)",
                color: active ? "var(--accent-color)" : "var(--text-primary)",
              }}
            >
              {op.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ValueInput({ label, engine }: { label: string; engine: UseCalculationEngineReturn }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs font-bold uppercase text-[var(--text-secondary)]">{label}</label>
      <input
        type="number"
        value={engine.value}
        onChange={(e) => engine.setValue(parseFloat(e.target.value) || 0)}
        className="w-24 bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-1.5 text-sm focus:outline-none focus:border-[var(--accent-color)]"
      />
    </div>
  );
}

/**
 * Free-typing text input with an optional suggestions dropdown -- NOT a
 * native `<input list>` + `<datalist>`. WebView2 renders that combo as a
 * locked-in select rather than an editable combobox (you can pick a
 * suggestion but can't then retype over it), so this reimplements the same
 * idea with a plain controlled input and a custom popup that never disables
 * typing.
 */
function ComboBox({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // Once the field already holds a complete, exact option (i.e. the user
  // picked one last time), filtering by that same text would only ever
  // match itself -- show the full list instead so switching to a different
  // option doesn't require clearing the field first.
  const filtered = options.includes(value)
    ? options
    : options.filter((o) => o.toLowerCase().includes(value.toLowerCase()));

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          e.target.select();
        }}
        placeholder={placeholder}
        className="w-full bg-[var(--card-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
      />
      {open && filtered.length > 0 && (
        <div
          className="absolute z-50 mt-1 w-full rounded border shadow-lg overflow-hidden max-h-40 overflow-y-auto"
          style={{ backgroundColor: "var(--card-bg)", borderColor: "var(--border)" }}
        >
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--hover-bg)] text-[var(--text-primary)]"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function buildPreviewText(
  engine: UseCalculationEngineReturn,
  selectedSensors: string[],
  getSensorName: (tag: string) => string,
  formulaText: string,
): string {
  if (engine.mode === "formula") {
    return formulaText.trim() || "Write a formula to see a preview.";
  }

  const names = selectedSensors.map(getSensorName);

  if (engine.opGroup === "single") {
    if (!engine.operationId) return `${names[0]} added as-is.`;
    const op = findOperation("single", engine.operationId);
    if (!op) return "";
    if (engine.operationId === "round") {
      return `Round ${names[0]} to ${engine.value} decimal place(s)`;
    }
    if (NUMBER_OP_IDS.includes(engine.operationId)) {
      return `${names[0]} ${op.symbol} ${engine.value}`;
    }
    return `${op.label} of ${names[0]}`;
  }

  // Multi-sensor. No shortcut chosen -> the chain (default "+" between
  // every sensor) is the calculation -- mirrors `useCalculationEngine`'s
  // `build()`, which no longer has an "as-is, no calculation" path once 2+
  // sensors are selected.
  let base: string;
  if (!engine.operationId) {
    base = names[0];
    for (let i = 0; i < selectedSensors.length - 1; i++) {
      base += ` ${engine.chainOps[i] ?? "+"} ${names[i + 1]}`;
    }
  } else {
    const op = findOperation("multi", engine.operationId);
    if (!op) return "";
    if (BASE_OP_IDS.includes(engine.operationId)) {
      const baseTag = engine.baseSensor || selectedSensors[0];
      const baseName = getSensorName(baseTag);
      if (engine.operationId === "efficiency_pct") {
        const outputName = names.find((_, idx) => selectedSensors[idx] !== baseTag) ?? names[1];
        base = `${outputName} ÷ ${baseName} × 100`;
      } else {
        const others = selectedSensors.filter((s) => s !== baseTag).map(getSensorName).join(" + ");
        base = `${baseName} ${op.symbol} (${others})`;
      }
    } else if (engine.operationId === "abs_diff") {
      base = `|${names[0]} − ${names[1]}|`;
    } else if (engine.operationId === "temp_spread") {
      base = `spread of ${names.join(", ")}`;
    } else {
      base = `${op.label}: ${names.join(", ")}`;
    }
  }

  if (!engine.wrapFunc) return base;
  const wrapOp = findOperation("single", engine.wrapFunc);
  if (engine.wrapFunc === "round") return `Round (${base}) to ${engine.wrapValue} decimal place(s)`;
  return wrapOp ? `${wrapOp.label} of (${base})` : base;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Formula editor -- power-user escape hatch, reached via "Edit as text instead"
 * ───────────────────────────────────────────────────────────────────────────── */

interface AdvancedModeProps {
  formulaEditor: ReturnType<typeof useFormulaEditor>;
  showSyntaxHelp: boolean;
  setShowSyntaxHelp: (show: boolean) => void;
}

function AdvancedMode({
  formulaEditor,
  showSyntaxHelp,
  setShowSyntaxHelp,
}: AdvancedModeProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Formula textarea with autocomplete */}
      <div>
        <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
          Formula Expression
        </label>
        <div className="relative">
          <textarea
            value={formulaEditor.formula}
            onChange={(e) =>
              formulaEditor.setFormula(
                e.target.value,
                e.target.selectionStart ?? 0
              )
            }
            onKeyUp={(e) => {
              const target = e.target as HTMLTextAreaElement;
              formulaEditor.setCursorPosition(target.selectionStart ?? 0);
            }}
            onClick={(e) => {
              const target = e.target as HTMLTextAreaElement;
              formulaEditor.setCursorPosition(target.selectionStart ?? 0);
            }}
            placeholder="= $SensorA + $SensorB * 2"
            className="w-full h-32 font-mono text-sm bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-3 resize-none focus:outline-none focus:border-[var(--accent-color)]"
          />

          {/* Autocomplete popup */}
          {formulaEditor.showAutocomplete &&
            formulaEditor.suggestions.length > 0 && (
              <div className="absolute z-50 bg-[var(--card-bg)] border border-[var(--border)] rounded shadow-lg max-h-40 overflow-y-auto w-full">
                {formulaEditor.suggestions.map((sensor) => (
                  <button
                    key={sensor}
                    onClick={() => formulaEditor.insertSensor(sensor)}
                    className="block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--hover-bg)] text-[var(--text-primary)]"
                  >
                    {sensor}
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>

      {/* Validation feedback */}
      {formulaEditor.isValidating && (
        <div className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
          <span className="animate-pulse">Validating...</span>
        </div>
      )}

      {formulaEditor.validationResult && (
        <div
          className={`text-xs mt-0 p-2 rounded border ${
            formulaEditor.validationResult.valid
              ? "bg-green-900/20 border-green-700 text-green-400"
              : "bg-red-900/20 border-red-700 text-red-400"
          }`}
        >
          {formulaEditor.validationResult.valid
            ? `Valid formula -- references ${formulaEditor.referencedSensors.length} sensor(s)`
            : formulaEditor.validationResult.error}
        </div>
      )}

      {/* Referenced sensors tags */}
      {formulaEditor.referencedSensors.length > 0 && (
        <div>
          <span className="text-xs text-[var(--text-secondary)]">
            Referenced sensors:
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {formulaEditor.referencedSensors.map((s) => (
              <span
                key={s}
                className="bg-[var(--accent-color)]/20 text-[var(--accent-color)] px-2 py-0.5 rounded text-xs"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Syntax help (collapsible) */}
      <div className="border border-[var(--border)] rounded overflow-hidden">
        <button
          onClick={() => setShowSyntaxHelp(!showSyntaxHelp)}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
        >
          <HelpCircle size={12} />
          <span className="font-semibold uppercase tracking-wider">
            Formula Syntax Help
          </span>
          {showSyntaxHelp ? (
            <ChevronDown size={12} className="ml-auto" />
          ) : (
            <ChevronRight size={12} className="ml-auto" />
          )}
        </button>
        {showSyntaxHelp && (
          <div className="px-3 py-2 text-xs text-[var(--text-secondary)] border-t border-[var(--border)] bg-[var(--input-bg)] space-y-1.5">
            <p className="font-semibold text-[var(--text-primary)]">
              Supported syntax:
            </p>
            <ul className="list-none space-y-1 ml-1">
              <li>
                <span className="text-[var(--accent-color)]">Sensors:</span>{" "}
                <code className="bg-[var(--card-bg)] px-1 rounded">
                  $SensorName
                </code>{" "}
                or{" "}
                <code className="bg-[var(--card-bg)] px-1 rounded">
                  {"${Sensor Name}"}
                </code>
              </li>
              <li>
                <span className="text-[var(--accent-color)]">Operators:</span>{" "}
                <code className="bg-[var(--card-bg)] px-1 rounded">
                  + - * / ^
                </code>
              </li>
              <li>
                <span className="text-[var(--accent-color)]">Functions:</span>{" "}
                <code className="bg-[var(--card-bg)] px-1 rounded">
                  abs, sqrt, pow, log, log10, exp, ceil, floor, round, min, max
                </code>
              </li>
              <li>
                <span className="text-[var(--accent-color)]">Example:</span>{" "}
                <code className="bg-[var(--card-bg)] px-1 rounded">
                  $SensorA + sqrt($SensorB) * 2
                </code>
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
