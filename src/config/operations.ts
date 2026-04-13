import type { OperationDefinition } from '../types/calculationEngine';

/**
 * Operation Registry -- Single Source of Truth
 *
 * All available sensor operations are defined here. Both the frontend UI
 * (dropdowns, labels, symbols) and the backend (operation lookup) derive
 * their behavior from these definitions.
 */
export const OPERATIONS: {
  single: OperationDefinition[];
  multi: OperationDefinition[];
} = {
  single: [
    { id: 'add', label: 'Add (+)', symbol: '+', category: 'arithmetic', requiresValue: true },
    { id: 'subtract', label: 'Subtract (-)', symbol: '-', category: 'arithmetic', requiresValue: true },
    { id: 'multiply', label: 'Multiply (\u00d7)', symbol: '\u00d7', category: 'arithmetic', requiresValue: true },
    { id: 'divide', label: 'Divide (\u00f7)', symbol: '\u00f7', category: 'arithmetic', requiresValue: true },
    { id: 'power', label: 'Power (^)', symbol: '^', category: 'arithmetic', requiresValue: true },
    { id: 'abs', label: 'Absolute', symbol: 'abs', category: 'transform', requiresValue: false },
    { id: 'log10', label: 'Log\u2081\u2080', symbol: 'log10', category: 'transform', requiresValue: false },
    { id: 'sqrt', label: 'Square Root', symbol: '\u221a', category: 'transform', requiresValue: false },
    {
      id: 'round',
      label: 'Round',
      symbol: 'round',
      category: 'transform',
      requiresValue: true,
      params: [{ name: 'decimals', type: 'number', default: 2 }],
    },
    { id: 'exp', label: 'Exponential', symbol: 'exp', category: 'transform', requiresValue: false },
    { id: 'ceil', label: 'Ceiling', symbol: 'ceil', category: 'transform', requiresValue: false },
    { id: 'floor', label: 'Floor', symbol: 'floor', category: 'transform', requiresValue: false },
  ],
  multi: [
    { id: 'sum', label: 'Sum', symbol: '\u03a3', category: 'aggregation', requiresValue: false },
    { id: 'mean', label: 'Average', symbol: '\u03bc', category: 'aggregation', requiresValue: false },
    { id: 'median', label: 'Median', symbol: 'M\u0303', category: 'aggregation', requiresValue: false },
    { id: 'product', label: 'Product', symbol: '\u220f', category: 'aggregation', requiresValue: false },
    { id: 'subtract', label: 'Subtract', symbol: '-', category: 'arithmetic', requiresValue: false, requiresBase: true },
    { id: 'divide', label: 'Divide', symbol: '\u00f7', category: 'arithmetic', requiresValue: false, requiresBase: true },
    {
      id: 'moving_avg',
      label: 'Moving Average',
      symbol: 'MA',
      category: 'time_series',
      requiresValue: false,
      params: [{ name: 'window_size', type: 'number', default: 10 }],
    },
    { id: 'rate_of_change', label: 'Rate of Change', symbol: '\u0394', category: 'time_series', requiresValue: false },
  ],
} as const;

/** Get operations grouped by category */
export function getOperationsByCategory(
  type: 'single' | 'multi',
): Record<string, OperationDefinition[]> {
  const ops = OPERATIONS[type];
  const grouped: Record<string, OperationDefinition[]> = {};
  for (const op of ops) {
    if (!grouped[op.category]) grouped[op.category] = [];
    grouped[op.category].push(op as OperationDefinition);
  }
  return grouped;
}

/** Find an operation by id */
export function findOperation(
  type: 'single' | 'multi',
  id: string,
): OperationDefinition | undefined {
  return (OPERATIONS[type] as readonly OperationDefinition[]).find(
    (op) => op.id === id,
  );
}
