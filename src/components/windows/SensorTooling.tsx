import { useState, useEffect } from "react";
import { SensorOperationConfig, SensorMetadata } from "../../types";
import { useCalculationEngine } from "../../hooks/useCalculationEngine";
import { useFormulaEditor } from "../../hooks/useFormulaEditor";
import { getOperationsByCategory } from "../../config/operations";
import type { OperationDefinition } from "../../types/calculationEngine";
import {
  Calculator,
  Users,
  Code2,
  Wand2,
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
}

export default function SensorTooling({
  selectedSensors,
  sensorMetadata,
  onConfigChange,
  onRemoveSensor,
  onFormulaSubmit,
}: SensorToolingProps) {
  const engine = useCalculationEngine(selectedSensors);
  // Autocomplete suggests ONLY the checked sensors so users can't reference
  // sensors they haven't pulled into the Target Sensors panel.
  const formulaEditor = useFormulaEditor(selectedSensors);

  const [showSyntaxHelp, setShowSyntaxHelp] = useState(false);

  // Sync formula between engine and formula editor
  useEffect(() => {
    if (engine.calcMode === "formula") {
      engine.setFormula(formulaEditor.formula);
    }
  }, [formulaEditor.formula, engine.calcMode]);

  // Notify parent of legacy config changes in simple mode
  useEffect(() => {
    if (engine.calcMode === "simple") {
      const legacyConfig = engine.buildLegacyConfig();
      onConfigChange(legacyConfig);
    } else {
      // In formula mode, clear the legacy config
      onConfigChange(null);
    }
  }, [
    engine.calcMode,
    engine.simpleType,
    engine.operationId,
    engine.value,
    engine.baseSensor,
    engine.customName,
    engine.params,
    selectedSensors,
  ]);

  // Notify parent of formula submission when user changes formula
  useEffect(() => {
    if (engine.calcMode === "formula" && onFormulaSubmit) {
      onFormulaSubmit(formulaEditor.formula, engine.customName || undefined);
    }
  }, [
    engine.calcMode,
    formulaEditor.formula,
    engine.customName,
    onFormulaSubmit,
  ]);

  // Safety check: if baseSensor is not in selectedSensors, reset it
  useEffect(() => {
    if (engine.baseSensor && !selectedSensors.includes(engine.baseSensor)) {
      engine.setBaseSensor(
        selectedSensors.length > 0 ? selectedSensors[0] : ""
      );
    } else if (!engine.baseSensor && selectedSensors.length > 0) {
      engine.setBaseSensor(selectedSensors[0]);
    }
  }, [selectedSensors, engine.baseSensor]);

  const getSensorName = (tag: string) => {
    const meta = sensorMetadata?.find((m) => m.tag === tag);
    return meta ? meta.description || tag : tag;
  };

  const grouped = getOperationsByCategory(engine.simpleType);
  const categoryLabels: Record<string, string> = {
    arithmetic: "Arithmetic",
    transform: "Transform",
    aggregation: "Aggregation",
    time_series: "Time Series",
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-secondary)] overflow-hidden">
      {/* Top-level mode toggle: Simple / Advanced */}
      <div className="flex border-b border-[var(--border)]">
        <button
          onClick={() => engine.setCalcMode("simple")}
          className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${
            engine.calcMode === "simple"
              ? "bg-[var(--accent-color)] text-white"
              : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
        >
          <Wand2 size={14} />
          Simple
        </button>
        <button
          onClick={() => engine.setCalcMode("formula")}
          className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${
            engine.calcMode === "formula"
              ? "bg-[var(--accent-color)] text-white"
              : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
        >
          <Code2 size={14} />
          Advanced
        </button>
      </div>

      <div className="flex-1 p-4 overflow-y-auto">
        {/* Target Sensors (shown in both modes) */}
        <div className="mb-4">
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
                {selectedSensors.map((s) => (
                  <span
                    key={s}
                    className="bg-[var(--card-bg)] text-[var(--text-primary)] px-2 py-0.5 rounded text-xs border border-[var(--border)] flex items-center gap-1"
                  >
                    {getSensorName(s)}
                    <button
                      onClick={() => onRemoveSensor(s)}
                      className="hover:text-red-500 focus:outline-none"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Custom Name (shown in both modes) */}
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
            Custom Name (Optional)
          </label>
          <input
            type="text"
            value={engine.customName}
            onChange={(e) => engine.setCustomName(e.target.value)}
            placeholder="e.g. Total Power"
            className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
          />
        </div>

        {/* ============= SIMPLE MODE ============= */}
        {engine.calcMode === "simple" && (
          <SimpleMode
            engine={engine}
            selectedSensors={selectedSensors}
            grouped={grouped}
            categoryLabels={categoryLabels}
            getSensorName={getSensorName}
          />
        )}

        {/* ============= ADVANCED (FORMULA) MODE ============= */}
        {engine.calcMode === "formula" && (
          <AdvancedMode
            formulaEditor={formulaEditor}
            showSyntaxHelp={showSyntaxHelp}
            setShowSyntaxHelp={setShowSyntaxHelp}
          />
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Simple Mode Sub-component
 * ───────────────────────────────────────────────────────────────────────────── */

interface SimpleModeProps {
  engine: ReturnType<typeof useCalculationEngine>;
  selectedSensors: string[];
  grouped: Record<string, OperationDefinition[]>;
  categoryLabels: Record<string, string>;
  getSensorName: (tag: string) => string;
}

function SimpleMode({
  engine,
  selectedSensors,
  grouped,
  categoryLabels,
  getSensorName,
}: SimpleModeProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Single / Multi sub-tabs */}
      <div className="flex rounded overflow-hidden border border-[var(--border)]">
        <button
          onClick={() => engine.setSimpleType("single")}
          className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
            engine.simpleType === "single"
              ? "bg-[var(--card-bg)] text-[var(--text-primary)] border-b-2 border-[var(--accent-color)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
        >
          <Calculator size={12} />
          Single Calc
        </button>
        <button
          onClick={() => engine.setSimpleType("multi")}
          className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
            engine.simpleType === "multi"
              ? "bg-[var(--card-bg)] text-[var(--text-primary)] border-b-2 border-[var(--accent-color)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
        >
          <Users size={12} />
          Multi Calc
        </button>
      </div>

      {/* Single calc warning */}
      {engine.simpleType === "single" && selectedSensors.length > 1 && (
        <span className="text-yellow-500 text-xs font-bold bg-yellow-900/20 p-2 rounded border border-yellow-700">
          Warning: Single Calc supports only one sensor. Please remove others or
          switch to Multi Calc.
        </span>
      )}

      {/* Registry-driven operation dropdown with optgroup */}
      <div>
        <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
          Operation
        </label>
        <select
          value={engine.operationId}
          onChange={(e) => engine.setOperationId(e.target.value)}
          className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
        >
          {Object.entries(grouped).map(([category, ops]) => (
            <optgroup
              key={category}
              label={categoryLabels[category] || category}
            >
              {ops.map((op) => (
                <option key={op.id} value={op.id}>
                  {op.label} ({op.symbol})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Value input -- shown when operation requires a value */}
      {engine.currentOperation?.requiresValue && (
        <div>
          <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
            Value
          </label>
          <input
            type="number"
            value={engine.value}
            onChange={(e) => engine.setValue(parseFloat(e.target.value) || 0)}
            className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
          />
        </div>
      )}

      {/* Base sensor dropdown -- shown when operation requires a base sensor */}
      {engine.currentOperation?.requiresBase && (
        <div className="animate-fade-in">
          <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
            Base Sensor (The{" "}
            {engine.operationId === "subtract" ? "Minuend" : "Dividend"})
          </label>
          <select
            value={engine.baseSensor}
            onChange={(e) => engine.setBaseSensor(e.target.value)}
            className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
          >
            {selectedSensors.map((s) => (
              <option key={s} value={s}>
                {getSensorName(s)}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-[var(--text-secondary)] mt-1 ml-1">
            {engine.operationId === "subtract"
              ? "Formula: Base - (Sum of others)"
              : "Formula: Base / (Sum of others)"}
          </p>
        </div>
      )}

      {/* Dynamic params -- e.g., decimals for round, window_size for moving_avg */}
      {engine.currentOperation?.params &&
        engine.currentOperation.params.length > 0 && (
          <div className="flex flex-col gap-3">
            {engine.currentOperation.params.map((param) => (
              <div key={param.name}>
                <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
                  {param.name.replace(/_/g, " ")}
                </label>
                <input
                  type="number"
                  value={engine.params[param.name] ?? (param.default as number)}
                  onChange={(e) =>
                    engine.setParams({
                      ...engine.params,
                      [param.name]: parseFloat(e.target.value) || 0,
                    })
                  }
                  className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                />
              </div>
            ))}
          </div>
        )}

      {/* Preview panel */}
      <div className="p-3 bg-[rgba(59,130,246,0.1)] border border-[var(--accent-color)] rounded text-xs text-[var(--text-primary)]">
        <span className="font-semibold text-[var(--accent-color)]">
          Preview:
        </span>
        <div className="mt-1">
          {selectedSensors.length > 0 ? (
            <div>
              {engine.customName && (
                <span className="font-bold">{engine.customName} = </span>
              )}
              {engine.preview}
            </div>
          ) : (
            <div className="text-[var(--text-secondary)]">
              Select sensors to see preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Advanced (Formula) Mode Sub-component
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
