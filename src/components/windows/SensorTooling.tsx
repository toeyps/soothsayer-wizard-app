import { useState, useEffect } from "react";
import { SensorOperationConfig, SingleOperationType, MultiOperationType, SensorMetadata } from "../../types";
import { Calculator, Users } from "lucide-react";

interface SensorToolingProps {
    selectedSensors: string[];
    sensorMetadata: SensorMetadata[] | null;
    onConfigChange: (config: SensorOperationConfig | null) => void;
    onRemoveSensor: (sensor: string) => void;
}

export default function SensorTooling({ selectedSensors, sensorMetadata, onConfigChange, onRemoveSensor }: SensorToolingProps) {
    const [mode, setMode] = useState<'single' | 'multi'>('single');

    // Single Op State
    const [singleOpType, setSingleOpType] = useState<SingleOperationType>('add');
    const [singleOpValue, setSingleOpValue] = useState<number>(0);

    // Multi Op State
    const [multiOpType, setMultiOpType] = useState<MultiOperationType>('mean');
    const [baseSensor, setBaseSensor] = useState<string>("");

    const [customName, setCustomName] = useState("");

    // Update config when local state changes
    useEffect(() => {
        if (selectedSensors.length === 0) {
            onConfigChange(null);
            return;
        }

        if (mode === 'single') {
            onConfigChange({
                mode: 'single',
                singleOp: {
                    type: singleOpType,
                    value: singleOpValue
                },
                customName: customName.trim() || undefined
            });
        } else {
            // Validate multi op
            if ((multiOpType === 'subtract' || multiOpType === 'divide') && !baseSensor) {
                // If base required but not set, maybe null or partial? 
                // Let's default baseSensor if not set and we have sensors
                if (selectedSensors.length > 0) {
                    setBaseSensor(selectedSensors[0]);
                }
            }

            onConfigChange({
                mode: 'multi',
                multiOp: {
                    type: multiOpType,
                    baseSensor: (multiOpType === 'subtract' || multiOpType === 'divide') ? baseSensor : undefined
                },
                customName: customName.trim() || undefined
            });
        }
    }, [mode, singleOpType, singleOpValue, multiOpType, baseSensor, selectedSensors, customName, onConfigChange]);

    // Safety check: if baseSensor is not in selectedSensors, reset it
    useEffect(() => {
        if (baseSensor && !selectedSensors.includes(baseSensor)) {
            setBaseSensor(selectedSensors.length > 0 ? selectedSensors[0] : "");
        } else if (!baseSensor && selectedSensors.length > 0) {
            setBaseSensor(selectedSensors[0]);
        }
    }, [selectedSensors, baseSensor]);

    const getSensorName = (tag: string) => {
        const meta = sensorMetadata?.find(m => m.tag === tag);
        return meta ? meta.description || tag : tag;
    };

    return (
        <div className="flex flex-col h-full bg-[var(--bg-secondary)] overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-[var(--border)]">
                <button
                    onClick={() => setMode('single')}
                    className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider flex items-center justify-center gap-2 ${mode === 'single' ? 'bg-[var(--accent-color)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]'}`}
                >
                    <Calculator size={14} />
                    Single Calc
                </button>
                <button
                    onClick={() => setMode('multi')}
                    className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider flex items-center justify-center gap-2 ${mode === 'multi' ? 'bg-[var(--accent-color)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]'}`}
                >
                    <Users size={14} />
                    Multi Calc
                </button>
            </div>

            <div className="flex-1 p-4 overflow-y-auto">
                <div className="mb-4">
                    <h3 className="text-xs font-bold uppercase text-[var(--text-secondary)] mb-2">Target Sensors</h3>
                    <div className="text-sm bg-[var(--input-bg)] p-2 rounded border border-[var(--border)] max-h-24 overflow-y-auto">
                        {selectedSensors.length === 0 ? (
                            <span className="text-[var(--text-secondary)] italic">No sensors selected</span>
                        ) : (
                            <div className="flex flex-wrap gap-1">
                                {selectedSensors.map(s => (
                                    <span key={s} className="bg-[var(--card-bg)] text-[var(--text-primary)] px-2 py-0.5 rounded text-xs border border-[var(--border)] flex items-center gap-1">
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

                <div className="mb-4">
                    <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">Custom Name (Optional)</label>
                    <input
                        type="text"
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder="e.g. Total Power"
                        className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                    />
                </div>

                {mode === 'single' && (
                    <div className="flex flex-col gap-4">
                        {selectedSensors.length > 1 && (
                            <span className="text-yellow-500 text-xs font-bold bg-yellow-900/20 p-2 rounded border border-yellow-700">
                                Warning: Single Calc supports only one sensor. Please remove others or switch to Multi Calc.
                            </span>
                        )}
                        <div>
                            <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">Operation</label>
                            <select
                                value={singleOpType}
                                onChange={(e) => setSingleOpType(e.target.value as SingleOperationType)}
                                className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                            >
                                <option value="add">Add (+)</option>
                                <option value="subtract">Subtract (-)</option>
                                <option value="multiply">Multiply (×)</option>
                                <option value="divide">Divide (÷)</option>
                                <option value="power">Power (^)</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">Value</label>
                            <input
                                type="number"
                                value={singleOpValue}
                                onChange={(e) => setSingleOpValue(parseFloat(e.target.value))}
                                className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                            />
                        </div>

                        <div className="p-3 bg-[rgba(59,130,246,0.1)] border border-[var(--accent-color)] rounded text-xs text-[var(--text-primary)]">
                            <div className="font-semibold mb-1 text-[var(--accent-color)]">Preview Formula:</div>
                            {selectedSensors.length > 0 ? (
                                <div>
                                    {customName ? <span className="font-bold">{customName} = </span> : ''}
                                    [Sensor] {singleOpType === 'add' ? '+' : singleOpType === 'subtract' ? '-' : singleOpType === 'multiply' ? '×' : singleOpType === 'divide' ? '÷' : '^'} {singleOpValue}
                                </div>
                            ) : (
                                <div className="text-[var(--text-secondary)]">Select sensors to see preview</div>
                            )}
                        </div>
                    </div>
                )}

                {mode === 'multi' && (
                    <div className="flex flex-col gap-4">
                        <div>
                            <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">Aggregation</label>
                            <select
                                value={multiOpType}
                                onChange={(e) => setMultiOpType(e.target.value as MultiOperationType)}
                                className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                            >
                                <option value="sum">Sum (Total)</option>
                                <option value="mean">Average (Mean)</option>
                                <option value="median">Median</option>
                                <option value="product">Product</option>
                                <option value="subtract">Subtract (Difference)</option>
                                <option value="divide">Divide (Ratio)</option>
                            </select>
                        </div>

                        {(multiOpType === 'subtract' || multiOpType === 'divide') && (
                            <div className="animate-fade-in">
                                <label className="block text-xs font-bold uppercase text-[var(--text-secondary)] mb-1">
                                    Base Sensor (The {multiOpType === 'subtract' ? 'Minuend' : 'Dividend'})
                                </label>
                                <select
                                    value={baseSensor}
                                    onChange={(e) => setBaseSensor(e.target.value)}
                                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] rounded p-2 text-sm focus:outline-none focus:border-[var(--accent-color)]"
                                >
                                    {selectedSensors.map(s => (
                                        <option key={s} value={s}>{getSensorName(s)}</option>
                                    ))}
                                </select>
                                <p className="text-[10px] text-[var(--text-secondary)] mt-1 ml-1">
                                    {multiOpType === 'subtract'
                                        ? "Formula: Base - (Sum of others)"
                                        : "Formula: Base / (Sum of others)"}
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
