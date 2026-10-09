import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SensorPickerModal } from '../components/windows/SensorPickers';
import * as SensorPickersModule from '../components/windows/SensorPickers';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import type { SensorMetadata } from '../types';
import { findPickerRow, openPickerSurface, pickerRows, rowTag } from './helpers/sensorPicker';

// 2026-10-09 (customer item 3): `SensorPickerModal` is now a thin adapter over the ONE shared
// picker (`src/components/sensor/SensorPicker.tsx`, tested in SensorPicker.test.tsx) — single →
// anchored popover, multi → chips + "Add…" + modal. These tests pin the adapter's wiring only.
// (BuildModelWindow.test.tsx and RunningConditionPanel.test.tsx mock this module out.)

afterEach(() => {
    cleanup();
    document.getElementById('wizard-portal-root')?.remove();
});

const META: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'BAR', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'DEGC', component: 'Pump' },
    { tag: 'TAG3', description: '', unit: '', component: '' },
];
const sensors = ['TAG1', 'TAG2', 'TAG3'];
const wrap = (ui: React.ReactElement) => render(<SensorMetaProvider metadata={META}>{ui}</SensorMetaProvider>);

describe('SensorPickerModal (adapter)', () => {
    it('SensorAutocomplete is retired — the module no longer exports it', () => {
        expect('SensorAutocomplete' in SensorPickersModule).toBe(false);
    });

    describe('single', () => {
        it('renders the single picker: placeholder "Pick {noun}…", popover, one click picks', () => {
            const onSelect = vi.fn();
            wrap(<SensorPickerModal single sensors={sensors} value="" onSelect={onSelect} noun="Y sensor" />);
            const trig = screen.getByRole('button', { name: 'Y sensor' });
            expect(trig.textContent).toBe('Pick Y sensor…');
            fireEvent.click(trig);
            expect(openPickerSurface().classList.contains('pk-pop')).toBe(true);
            fireEvent.click(findPickerRow('TAG2'));
            expect(onSelect).toHaveBeenCalledWith('TAG2');
        });

        it('excluded sensors are not offered; invalid → required look; allowNone → a None row', () => {
            const onSelect = vi.fn();
            wrap(<SensorPickerModal single sensors={sensors} excluded={['TAG1']} value="" onSelect={onSelect} noun="criteria sensor" invalid allowNone placeholder="None" />);
            const trig = screen.getByRole('button', { name: 'criteria sensor' });
            expect(trig.classList.contains('req')).toBe(true);
            fireEvent.click(trig);
            fireEvent.change(openPickerSurface().querySelector('input')!, { target: { value: 'tag' } });
            expect(pickerRows().map(rowTag)).toEqual(['TAG2', 'TAG3']);
            fireEvent.change(openPickerSurface().querySelector('input')!, { target: { value: '' } });
            fireEvent.click(pickerRows().find(r => r.classList.contains('pk-item--none'))!);
            expect(onSelect).toHaveBeenCalledWith('');
        });

        it('groups with the caller\'s getComponent', () => {
            wrap(<SensorPickerModal single sensors={sensors} value="" onSelect={() => {}} noun="sensor" getComponent={t => (t === 'TAG3' ? 'Valve' : 'Pump')} />);
            fireEvent.click(screen.getByRole('button', { name: 'sensor' }));
            expect([...openPickerSurface().querySelectorAll('.pk-gname')].map(e => e.textContent)).toEqual(['Pump', 'Valve']);
        });

        it('disabled with a reason', () => {
            wrap(<SensorPickerModal single sensors={sensors} value="" onSelect={() => {}} noun="sensor" disabled disabledReason="No predictors selected" />);
            const trig = screen.getByRole('button', { name: 'sensor' }) as HTMLButtonElement;
            expect(trig.disabled).toBe(true);
            expect(trig.textContent).toBe('No predictors selected');
        });
    });

    describe('multi', () => {
        it('chips + "Add…" + modal; OK confirms the whole new selection; the scope line is passed through', () => {
            const onConfirm = vi.fn();
            wrap(<SensorPickerModal sensors={sensors} selected={['TAG1']} excluded={['TAG3']} onConfirm={onConfirm} noun="predictors" scope={<>All sensors except the target · 2</>} />);
            expect(document.querySelectorAll('.pk-chip').length).toBe(1);
            fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
            expect(screen.getByRole('dialog', { name: 'Select predictors' })).toBeTruthy();
            expect(openPickerSurface().querySelector('.pk-scope')?.textContent).toBe('All sensors except the target · 2');
            fireEvent.change(openPickerSurface().querySelector('input')!, { target: { value: 'tag' } });
            expect(pickerRows().map(rowTag)).toEqual(['TAG1', 'TAG2']); // TAG3 excluded
            fireEvent.click(findPickerRow('TAG2'));
            fireEvent.click(screen.getByRole('button', { name: /OK/ }));
            expect(onConfirm).toHaveBeenCalledWith(['TAG1', 'TAG2']);
        });

        it('a chip\'s × removes that one sensor', () => {
            const onConfirm = vi.fn();
            wrap(<SensorPickerModal sensors={sensors} selected={['TAG1', 'TAG2']} onConfirm={onConfirm} noun="predictors" />);
            fireEvent.click(screen.getByRole('button', { name: 'Remove Pump Pressure' }));
            expect(onConfirm).toHaveBeenCalledWith(['TAG2']);
        });

        it('invalid + empty → amber "Add predictors…"', () => {
            wrap(<SensorPickerModal sensors={sensors} selected={[]} onConfirm={() => {}} noun="predictors" invalid />);
            const add = screen.getByRole('button', { name: 'Add predictors…' });
            expect(add.classList.contains('req')).toBe(true);
        });
    });
});
