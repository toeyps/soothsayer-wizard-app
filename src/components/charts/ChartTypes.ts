import { CsvRecord } from '../../types';

export interface ChartProps {
    data: CsvRecord[];
    sensors: string[];
    headers: string[];
}
