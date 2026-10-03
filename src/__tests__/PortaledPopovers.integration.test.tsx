/**
 * QA cross-cutting sweep for visual refresh Phase 1 (commit a4d3604):
 * the add-to-failure-group / alarm-setpoints popovers (SensorSelection) and
 * the two colour popovers (HighlightsPanel) moved from expanding inline in
 * a scrolling list to `AnchoredPopover` + `Portal` (position: fixed,
 * portaled into `#wizard-portal-root` on document.body).
 * (2026-10-03: the add-to-failure-group one is now the Failure Group
 * Assignment sheet — still portaled, but docked to the Sensors panel and not
 * dismissed by scroll/resize; its describe blocks below were re-pointed.)
 *
 * Seam under test: each component's own open/close state <-> the shared
 * `AnchoredPopover`'s portal + scroll/resize self-close + click
 * stopPropagation. The worker tests cover "it renders in the portal root";
 * these cover what a portal changes about INTERACTION:
 *   - React synthetic events still bubble through the React tree (not the
 *     DOM tree) across a portal, so a click inside the popover would reach
 *     the sensor row's own onClick (toggle selection) without the
 *     popover's stopPropagation.
 *   - onRequestClose must clear the component's own "which one is open"
 *     state, or the next trigger click would toggle it "closed" (a no-op
 *     from the user's point of view) instead of reopening it.
 *   - the scroll-closes-itself listener is `capture: true` on window, so it
 *     sees EVERY element's scroll — including scrolls that happen inside
 *     the popover itself; `AnchoredPopover` now ignores those (see the
 *     regression cases at the bottom, fixed 2026-10-02).
 *
 * Real ColorPlatePicker is used (not mocked) so the HighlightsPanel case
 * exercises the actual pointer-driven picker inside the portal.
 */
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

// ── SensorSelection fixtures ─────────────────────────────────────────────

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

// 2026-10-03: the add-to-failure-group menu is no longer an AnchoredPopover — it
// is the full-height assignment sheet docked to the Sensors panel (still
// portaled into #wizard-portal-root). The alarm-setpoints list is still an
// AnchoredPopover, so this file keeps covering both: what a portal changes
// about INTERACTION (React events bubble through the React tree, not the DOM
// tree) and the open/close state each one owns.
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

    // ── Regression tests for bugs QA found in Phase 1 (fixed 2026-10-02) ──

    describe('popover bugs fixed 2026-10-02 (re-pointed at the sheet where they still apply)', () => {
        // `AnchoredPopover`'s window-level `capture: true` scroll listener used
        // to close a popover on the first wheel tick INSIDE its own scrolling
        // list. The sheet has no such listener, but it has its own scrolling
        // list of groups and its own re-measuring scroll listener — a scroll
        // inside the sheet must neither close it nor be mistaken for the sensor
        // list moving.
        it('scrolling INSIDE the sheet\'s own group list (many groups) does not close it', () => {
            const manyGroups: FailureGroup[] = [{ no: 0, name: 'Not in Group' }];
            for (let i = 1; i <= 15; i++) manyGroups.push({ no: i, name: `Group ${i}` });
            renderSensorSelection({ fgGroups: manyGroups });
            fireEvent.click(folderButtons()[0]);
            fireEvent.scroll(document.querySelector('.fg-sheet-list')!);
            expect(sheet()).not.toBeNull();
        });

        // Chromium dispatches a `scroll` event on an <input> whose text
        // scrolls horizontally once it overflows. That used to close the
        // popover mid-typing; it must not close the sheet either.
        it('typing a long name into "New failure group name" (the input scrolls horizontally) does not close the sheet', () => {
            renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            const input = screen.getByPlaceholderText('New failure group name');
            fireEvent.change(input, { target: { value: 'Mechanical seal leakage on discharge side' } });
            fireEvent.scroll(input); // what Chromium fires once the text overflows
            expect(screen.queryByPlaceholderText('New failure group name')).not.toBeNull();
        });

        // The alarm list and the sheet's 📁 live in the same row; the alarm
        // list is a `position: fixed` popover under the bell. One panel at a
        // time (both directions) keeps them from stacking.
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

// ── HighlightsPanel (real ColorPlatePicker inside the portal) ─────────────

function highlightProps(overrides: Partial<React.ComponentProps<typeof HighlightsPanel>> = {}) {
    return {
        timeHighlights: [] as TimeHighlight[],
        onAddTimeHighlight: vi.fn(),
        onToggleTimeHighlight: vi.fn(),
        onRemoveTimeHighlight: vi.fn(),
        onRecolorTimeHighlight: vi.fn(),
        onRenameTimeHighlight: vi.fn(),
        lineDisplay: 'band' as const,
        onSetLineDisplay: vi.fn(),
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
        fireEvent.click(screen.getByTitle('Change colour'));
        const pop = openPopovers()[0];
        expect(pop).toBeTruthy();
        // popover > ColorPlatePicker root > SV square.
        const square = pop.firstElementChild!.firstElementChild as HTMLElement;
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
        fireEvent.click(screen.getByTitle('Change colour'));
        expect(openPopovers()).toHaveLength(1);
        fireEvent.scroll(document.body);
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(screen.getByTitle('Change colour'));
        expect(openPopovers()).toHaveLength(1);
    });

    it('the value-range colour popover closes on resize and reopens with ONE click', () => {
        const valueHighlight: ValueHighlight = { sensor: 'TAG1', ranges: [{ id: 'r1', min: 1, max: 2, color: '#00ff00', enabled: true }] };
        render(<HighlightsPanel {...highlightProps({ valueHighlight })} />);
        fireEvent.click(screen.getByTitle('Change colour'));
        expect(openPopovers()).toHaveLength(1);
        fireEvent(window, new Event('resize'));
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(screen.getByTitle('Change colour'));
        expect(openPopovers()).toHaveLength(1);
    });
});
