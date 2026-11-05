/** Portaled popovers: inside clicks must not toggle the sensor row; `onRequestClose` clears open state; inner scrolls are ignored. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SensorSelection from '../components/dashboard/SensorSelection';
import HighlightsPanel from '../components/dashboard/HighlightsPanel';
import type { FailureGroup, FailureModel, SensorMetadata, TimeHighlight, ValueHighlight } from '../types';

let origSetPointerCapture: any;
beforeEach(() => {
    origSetPointerCapture = (Element.prototype as any).setPointerCapture;
    (Element.prototype as any).setPointerCapture = vi.fn(); // jsdom doesn't implement this
});
afterEach(() => {
    cleanup();
    (Element.prototype as any).setPointerCapture = origSetPointerCapture;
    document.getElementById('wizard-portal-root')?.remove();
});

const portalRoot = () => document.getElementById('wizard-portal-root');
const openPopovers = () => Array.from(document.querySelectorAll<HTMLElement>('#wizard-portal-root .sensor-popover'));


const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmH: 90, alarmL: 10 },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];
const groupA: FailureGroup = { no: 1, name: 'Group A' };
const modelTag1InGroupA: FailureModel = {
    id: 'm1', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
    targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
    individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
    relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
    clusterRanges: [], filterTimePeriods: [],
    runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
};

function sensorProps(overrides: Partial<React.ComponentProps<typeof SensorSelection>> = {}) {
    return {
        sensors: ['TAG1', 'TAG2'],
        selectedSensors: [] as string[],
        onSensorChange: vi.fn(),
        sensorMetadata,
        fgGroups: [{ no: 0, name: 'Not in Group' }, groupA],
        fgModels: [modelTag1InGroupA],
        getGroupColor: () => 'blue',
        onToggleSensorGroupKind: vi.fn(),
        onCreateGroupForSensor: vi.fn(),
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        alarmLinesEnabled: {} as Record<string, any>,
        onToggleAlarmLine: vi.fn(),
        ...overrides,
    };
}

function renderSensorSelection(overrides: Partial<React.ComponentProps<typeof SensorSelection>> = {}) {
    const props = sensorProps(overrides);
    const utils = render(<SensorSelection {...props} />);
    fireEvent.click(screen.getByText('Pump')); // expand the component group
    return { ...utils, props };
}

const folderButtons = () => screen.getAllByTitle('Add to failure group');
const sheet = () => screen.queryByTestId('fg-sheet');

// The failure-group menu is a docked sheet (portaled, not an `AnchoredPopover`); the alarm list is a popover. Both covered.
describe('SensorSelection panels through Portal — interaction seam', () => {
    describe('clicks INSIDE the portaled sheet/popover never reach the sensor row (React bubbles through portals)', () => {
        it('assignment sheet: a matrix cell fires its own handler, does NOT toggle the row\'s selection, and the sheet stays open', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(folderButtons()[1]); // TAG2
            fireEvent.click(screen.getByRole('button', { name: 'Individual · Group A' }));
            expect(props.onToggleSensorGroupKind).toHaveBeenCalledWith('TAG2', 1, 'individual');
            expect(props.onSensorChange).not.toHaveBeenCalled();
            expect(sheet()).not.toBeNull();
        });

        it('assignment sheet: clicking its heading, the new-group input and a group\'s ⋯ menu never toggle the row', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]); // TAG1
            fireEvent.click(screen.getByText('Failure groups', { selector: '.fg-sheet-kicker' }));
            fireEvent.click(screen.getByPlaceholderText('New failure group name'));
            fireEvent.click(screen.getByRole('button', { name: 'Group actions: Group A' }));
            fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
            expect(props.onSensorChange).not.toHaveBeenCalled();
            // Rename swapped the row into its edit field, still inside the same (still open) sheet.
            expect(sheet()).not.toBeNull();
            expect(sheet()!.contains(screen.getByDisplayValue('Group A'))).toBe(true);
        });

        it('assignment sheet: typing + Enter in the new-group input commits for the edited sensor, without toggling its row', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(folderButtons()[1]); // TAG2
            const input = screen.getByPlaceholderText('New failure group name');
            fireEvent.change(input, { target: { value: 'Seal leak' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(props.onCreateGroupForSensor).toHaveBeenCalledWith('TAG2', 'Seal leak');
            expect(props.onSensorChange).not.toHaveBeenCalled();
        });

        it('alarm setpoints: clicking a level\'s LABEL text (which re-dispatches a click on its checkbox) toggles the alarm line only, not the row', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            fireEvent.click(screen.getByText('High (90)'));
            expect(props.onToggleAlarmLine).toHaveBeenCalledWith('TAG1', 'H');
            expect(props.onToggleAlarmLine).toHaveBeenCalledTimes(1);
            expect(props.onSensorChange).not.toHaveBeenCalled();
            expect(openPopovers()).toHaveLength(1);
        });

        it('the sheet lives in #wizard-portal-root, outside the component\'s own DOM container', () => {
            const { container } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            expect(container.contains(sheet())).toBe(false);
            expect(portalRoot()!.contains(screen.getByPlaceholderText('New failure group name'))).toBe(true);
        });
    });

    describe('open state resets with the component\'s own state', () => {
        it('scrolling the sensor list does NOT close the sheet (the old popover did) and the 📁 stays "on"', () => {
            const { container } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            expect(sheet()).not.toBeNull();
            expect(folderButtons()[0].classList.contains('on')).toBe(true);
            fireEvent.scroll(container.querySelector('.sensor-list-widget')!);
            expect(sheet()).not.toBeNull();
            expect(folderButtons()[0].classList.contains('on')).toBe(true);
        });

        it('a window resize closes the alarm popover and ONE click on the bell reopens it', () => {
            renderSensorSelection();
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            expect(screen.getByText('High (90)')).toBeTruthy();
            fireEvent(window, new Event('resize'));
            expect(screen.queryByText('High (90)')).toBeNull();
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            expect(screen.getByText('High (90)')).toBeTruthy();
        });

        it('a window resize keeps the sheet open (it re-measures instead) — only the anchored popovers close on resize', () => {
            renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            fireEvent(window, new Event('resize'));
            expect(sheet()).not.toBeNull();
        });

        it('collapsing the component group closes the open sheet (its row — and so its arrow target — is gone)', () => {
            renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            expect(sheet()).not.toBeNull();
            fireEvent.click(screen.getByText('Pump')); // collapse
            expect(sheet()).toBeNull();
        });

        it('switching the sheet from one sensor to another moves the row highlight and the heading', () => {
            const { container } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            expect(container.querySelector('.sensor-list-row--fg-target')!.textContent).toContain('Pump Pressure');
            fireEvent.click(folderButtons()[1]);
            expect(screen.getAllByTestId('fg-sheet')).toHaveLength(1);
            expect(container.querySelectorAll('.sensor-list-row--fg-target')).toHaveLength(1);
            expect(container.querySelector('.sensor-list-row--fg-target')!.textContent).toContain('Pump Temp');
            expect(screen.getByTestId('fg-sheet').getAttribute('aria-label')).toBe('Failure groups for Pump Temp');
        });
    });


    describe('popover bugs fixed 2026-10-02 (re-pointed at the sheet where they still apply)', () => {
        // A scroll inside the sheet's own group list must neither close it nor be mistaken for the sensor list moving.
        it('scrolling INSIDE the sheet\'s own group list (many groups) does not close it', () => {
            const manyGroups: FailureGroup[] = [{ no: 0, name: 'Not in Group' }];
            for (let i = 1; i <= 15; i++) manyGroups.push({ no: i, name: `Group ${i}` });
            renderSensorSelection({ fgGroups: manyGroups });
            fireEvent.click(folderButtons()[0]);
            fireEvent.scroll(document.querySelector('.fg-sheet-list')!);
            expect(sheet()).not.toBeNull();
        });

        // Chromium fires `scroll` on an overflowing <input>; that must not close the sheet mid-typing.
        it('typing a long name into "New failure group name" (the input scrolls horizontally) does not close the sheet', () => {
            renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            const input = screen.getByPlaceholderText('New failure group name');
            fireEvent.change(input, { target: { value: 'Mechanical seal leakage on discharge side' } });
            fireEvent.scroll(input); // what Chromium fires once the text overflows
            expect(screen.queryByPlaceholderText('New failure group name')).not.toBeNull();
        });

        // The alarm popover and the sheet share a row; only one panel is open at a time.
        it('only one sensor-list panel is open at a time: the alarm popover and the sheet exclude each other', () => {
            renderSensorSelection();
            fireEvent.click(screen.getByTitle('Alarm setpoints')); // TAG1
            fireEvent.click(folderButtons()[0]); // TAG1
            expect(sheet()).not.toBeNull();
            expect(openPopovers()).toHaveLength(0);
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            expect(sheet()).toBeNull();
            expect(openPopovers()).toHaveLength(1);
        });
    });
});


function highlightProps(overrides: Partial<React.ComponentProps<typeof HighlightsPanel>> = {}) {
    return {
        timeHighlights: [] as TimeHighlight[],
        onAddTimeHighlight: vi.fn(),
        onToggleTimeHighlight: vi.fn(),
        onRemoveTimeHighlight: vi.fn(),
        onRecolorTimeHighlight: vi.fn(),
        onRenameTimeHighlight: vi.fn(),
        valueHighlight: { sensor: '', ranges: [] } as ValueHighlight,
        valueHighlightSensors: ['TAG1'],
        onSetValueHighlightSensor: vi.fn(),
        onAddValueHighlightRange: vi.fn(),
        onToggleValueHighlightRange: vi.fn(),
        onRemoveValueHighlightRange: vi.fn(),
        onRecolorValueHighlightRange: vi.fn(),
        chartType: 'scatter' as const,
        ...overrides,
    };
}

const h1: TimeHighlight = { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true };

describe('HighlightsPanel colour popovers through Portal — interaction seam', () => {
    it('picking a colour with the REAL ColorPlatePicker inside the portal recolours, keeps the popover open, and does not toggle/remove the chip', () => {
        const props = highlightProps({ timeHighlights: [h1] });
        render(<HighlightsPanel {...props} />);
        fireEvent.click(screen.getByTitle('Highlight colour'));
        const pop = openPopovers()[0];
        expect(pop).toBeTruthy();
        // Shared ColourPicker: #ff0000 is not a palette colour, so "Custom
        // colour" is open — its ColorPlatePicker root > SV square.
        const square = pop.querySelector('.cp-adv')!.firstElementChild!.firstElementChild as HTMLElement;
        square.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
        fireEvent.pointerDown(square, { clientX: 0, clientY: 0, pointerId: 1 });
        fireEvent.click(square);
        expect(props.onRecolorTimeHighlight).toHaveBeenCalledWith('h1', '#ffffff');
        expect(props.onToggleTimeHighlight).not.toHaveBeenCalled();
        expect(props.onRemoveTimeHighlight).not.toHaveBeenCalled();
        expect(openPopovers()).toHaveLength(1);
    });

    it('a scroll anywhere closes the time-highlight colour popover, and ONE swatch click reopens it', () => {
        render(<HighlightsPanel {...highlightProps({ timeHighlights: [h1] })} />);
        fireEvent.click(screen.getByTitle('Highlight colour'));
        expect(openPopovers()).toHaveLength(1);
        fireEvent.scroll(document.body);
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(screen.getByTitle('Highlight colour'));
        expect(openPopovers()).toHaveLength(1);
    });

    it('the value-range colour popover closes on resize and reopens with ONE click', () => {
        const valueHighlight: ValueHighlight = { sensor: 'TAG1', ranges: [{ id: 'r1', min: 1, max: 2, color: '#00ff00', enabled: true }] };
        render(<HighlightsPanel {...highlightProps({ valueHighlight })} />);
        fireEvent.click(screen.getByTitle('Range colour'));
        expect(openPopovers()).toHaveLength(1);
        fireEvent(window, new Event('resize'));
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(screen.getByTitle('Range colour'));
        expect(openPopovers()).toHaveLength(1);
    });
});
