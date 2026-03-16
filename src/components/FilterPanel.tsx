import { useState } from 'react';
import { Plus, X, GripVertical, Copy } from 'lucide-react';

export interface LogicCondition {
    id: string;
    connector: 'IF' | 'AND' | 'OR' | 'THEN';
    sensor: string;
    operation: 'less_than' | 'greater_than' | 'between' | 'equals';
    value1: string;
    value2: string;
}

export interface LogicBlock {
    id: string;
    conditions: LogicCondition[];
}

export interface ValueFilter {
    id: string;
    sensor: string;
    operation: 'less_than' | 'greater_than' | 'between';
    value1: number | null;
    value2: number | null;
}

interface FilterPanelProps {
    selectedSensors?: string[];
}

export default function FilterPanel({
    selectedSensors = [],
}: FilterPanelProps) {

    const [logicBlocks, setLogicBlocks] = useState<LogicBlock[]>([]);

    const operationLabels: Record<string, string> = {
        less_than: 'IS LESS THAN',
        greater_than: 'IS GREATER THAN',
        between: 'IS BETWEEN',
        equals: 'IS EQUAL TO'
    };

    const addLogicBlock = () => {
        const newBlock: LogicBlock = {
            id: `block-${Date.now()}`,
            conditions: [
                {
                    id: `cond-${Date.now()}`,
                    connector: 'IF',
                    sensor: selectedSensors[0] || '',
                    operation: 'greater_than',
                    value1: '',
                    value2: ''
                }
            ]
        };
        setLogicBlocks([...logicBlocks, newBlock]);
    };

    const removeLogicBlock = (blockId: string) => {
        setLogicBlocks(logicBlocks.filter(b => b.id !== blockId));
    };

    const duplicateLogicBlock = (blockId: string) => {
        const block = logicBlocks.find(b => b.id === blockId);
        if (block) {
            const newBlock: LogicBlock = {
                id: `block-${Date.now()}`,
                conditions: block.conditions.map(c => ({
                    ...c,
                    id: `cond-${Date.now()}-${Math.random()}`
                }))
            };
            setLogicBlocks([...logicBlocks, newBlock]);
        }
    };

    const addCondition = (blockId: string, connector: 'AND' | 'OR') => {
        setLogicBlocks(logicBlocks.map(block => {
            if (block.id === blockId) {
                return {
                    ...block,
                    conditions: [
                        ...block.conditions,
                        {
                            id: `cond-${Date.now()}`,
                            connector: connector,
                            sensor: selectedSensors[0] || '',
                            operation: 'greater_than' as const,
                            value1: '',
                            value2: ''
                        }
                    ]
                };
            }
            return block;
        }));
    };

    const removeCondition = (blockId: string, conditionId: string) => {
        setLogicBlocks(logicBlocks.map(block => {
            if (block.id === blockId) {
                const newConditions = block.conditions.filter(c => c.id !== conditionId);
                // If first condition is removed, update the next one to be IF
                if (newConditions.length > 0 && newConditions[0].connector !== 'IF') {
                    newConditions[0] = { ...newConditions[0], connector: 'IF' };
                }
                return { ...block, conditions: newConditions };
            }
            return block;
        }));
    };

    const updateCondition = (blockId: string, conditionId: string, field: keyof LogicCondition, value: string) => {
        setLogicBlocks(logicBlocks.map(block => {
            if (block.id === blockId) {
                return {
                    ...block,
                    conditions: block.conditions.map(c =>
                        c.id === conditionId ? { ...c, [field]: value } : c
                    )
                };
            }
            return block;
        }));
    };

    const connectorStyle = (connector: string) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0.2rem 0.5rem',
        background: connector === 'IF' || connector === 'THEN' ? '#e0e7ff' : '#dbeafe',
        color: '#3b82f6',
        borderRadius: '4px',
        fontSize: '0.7rem',
        fontWeight: 600,
        minWidth: '40px'
    });

    return (
        <div className="filter-panel-new" style={{ width: '100%' }}>
            {/* Header */}
            <div style={{
                fontSize: '0.7rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
            }}>
                Logical Blocks (Drag-and-Drop to Reorder)
            </div>

            {/* Logic Blocks */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '0.75rem' }}>
                {logicBlocks.map((block, blockIndex) => (
                    <div
                        key={block.id}
                        style={{
                            width: '100%',
                            background: 'rgba(59, 130, 246, 0.05)',
                            border: '2px solid rgba(59, 130, 246, 0.3)',
                            borderRadius: '8px',
                            padding: '0.75rem',
                            position: 'relative'
                        }}
                    >
                        {/* Block Header */}
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '0.5rem',
                            paddingBottom: '0.5rem',
                            borderBottom: '1px solid var(--border)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <GripVertical size={14} style={{ color: 'var(--text-secondary)', cursor: 'grab' }} />
                                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    LOGIC BLOCK {blockIndex + 1}
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.25rem' }}>
                                <button
                                    onClick={() => duplicateLogicBlock(block.id)}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        padding: '0.25rem'
                                    }}
                                    title="Duplicate"
                                >
                                    <Copy size={14} />
                                </button>
                                <button
                                    onClick={() => removeLogicBlock(block.id)}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        padding: '0.25rem'
                                    }}
                                    title="Remove"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>

                        {/* Conditions */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                            {block.conditions.map((condition, condIndex) => (
                                <div
                                    key={condition.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.4rem',
                                        flexWrap: 'wrap'
                                    }}
                                >
                                    <GripVertical size={12} style={{ color: 'var(--text-secondary)', cursor: 'grab' }} />

                                    {/* Connector */}
                                    {condIndex === 0 ? (
                                        <span style={connectorStyle('IF')}>IF</span>
                                    ) : (
                                        <select
                                            value={condition.connector}
                                            onChange={(e) => updateCondition(block.id, condition.id, 'connector', e.target.value)}
                                            style={{
                                                ...connectorStyle(condition.connector),
                                                border: 'none',
                                                cursor: 'pointer',
                                                outline: 'none'
                                            }}
                                        >
                                            <option value="AND">AND</option>
                                            <option value="OR">OR</option>
                                        </select>
                                    )}

                                    {/* Sensor Select */}
                                    <select
                                        value={condition.sensor}
                                        onChange={(e) => updateCondition(block.id, condition.id, 'sensor', e.target.value)}
                                        style={{
                                            padding: '0.3rem 0.5rem',
                                            background: 'var(--input-bg)',
                                            border: '1px solid var(--border)',
                                            borderRadius: '4px',
                                            color: 'var(--text-primary)',
                                            fontSize: '0.75rem',
                                            outline: 'none',
                                            cursor: 'pointer',
                                            minWidth: '120px'
                                        }}
                                    >
                                        {selectedSensors.map(sensor => (
                                            <option key={sensor} value={sensor} style={{ background: 'var(--bg-secondary)' }}>
                                                {sensor}
                                            </option>
                                        ))}
                                    </select>

                                    {/* Value 1 */}
                                    <input
                                        type="number"
                                        value={condition.value1}
                                        onChange={(e) => updateCondition(block.id, condition.id, 'value1', e.target.value)}
                                        placeholder="Value"
                                        style={{
                                            width: '60px',
                                            padding: '0.3rem 0.5rem',
                                            background: 'var(--input-bg)',
                                            border: '1px solid var(--border)',
                                            borderRadius: '4px',
                                            color: 'var(--text-primary)',
                                            fontSize: '0.75rem',
                                            outline: 'none'
                                        }}
                                    />

                                    {/* Operation Select */}
                                    <select
                                        value={condition.operation}
                                        onChange={(e) => updateCondition(block.id, condition.id, 'operation', e.target.value)}
                                        style={{
                                            padding: '0.3rem 0.5rem',
                                            background: '#dbeafe',
                                            border: '1px solid #93c5fd',
                                            borderRadius: '4px',
                                            color: '#2563eb',
                                            fontSize: '0.7rem',
                                            fontWeight: 500,
                                            outline: 'none',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        <option value="greater_than">{operationLabels.greater_than}</option>
                                        <option value="less_than">{operationLabels.less_than}</option>
                                        <option value="between">{operationLabels.between}</option>
                                        <option value="equals">{operationLabels.equals}</option>
                                    </select>

                                    {/* Value 2 (for between) */}
                                    {condition.operation === 'between' && (
                                        <input
                                            type="number"
                                            value={condition.value2}
                                            onChange={(e) => updateCondition(block.id, condition.id, 'value2', e.target.value)}
                                            placeholder="Max"
                                            style={{
                                                width: '60px',
                                                padding: '0.3rem 0.5rem',
                                                background: 'var(--input-bg)',
                                                border: '1px solid var(--border)',
                                                borderRadius: '4px',
                                                color: 'var(--text-primary)',
                                                fontSize: '0.75rem',
                                                outline: 'none'
                                            }}
                                        />
                                    )}

                                    {/* Remove Condition */}
                                    {block.conditions.length > 1 && (
                                        <button
                                            onClick={() => removeCondition(block.id, condition.id)}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'var(--text-secondary)',
                                                cursor: 'pointer',
                                                padding: '0.15rem'
                                            }}
                                        >
                                            <X size={12} />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Add Condition Buttons */}
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                            <button
                                onClick={() => addCondition(block.id, 'AND')}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.25rem 0.5rem',
                                    background: 'transparent',
                                    border: '1px dashed var(--border)',
                                    borderRadius: '4px',
                                    color: 'var(--text-secondary)',
                                    fontSize: '0.7rem',
                                    cursor: 'pointer'
                                }}
                            >
                                <Plus size={12} /> AND
                            </button>
                            <button
                                onClick={() => addCondition(block.id, 'OR')}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.25rem 0.5rem',
                                    background: 'transparent',
                                    border: '1px dashed var(--border)',
                                    borderRadius: '4px',
                                    color: 'var(--text-secondary)',
                                    fontSize: '0.7rem',
                                    cursor: 'pointer'
                                }}
                            >
                                <Plus size={12} /> OR
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            {/* Add New Logic Block Button */}
            <button
                onClick={addLogicBlock}
                disabled={selectedSensors.length === 0}
                style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    padding: '0.6rem',
                    background: 'transparent',
                    border: '2px dashed var(--border)',
                    borderRadius: '8px',
                    color: 'var(--text-secondary)',
                    fontSize: '0.8rem',
                    cursor: selectedSensors.length > 0 ? 'pointer' : 'not-allowed',
                    transition: 'all 0.2s'
                }}
            >
                <Plus size={16} />
                Add New Logic Block
            </button>
        </div>
    );
}
