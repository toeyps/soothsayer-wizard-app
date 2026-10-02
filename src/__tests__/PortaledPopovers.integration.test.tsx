/**
 * QA cross-cutting sweep for visual refresh Phase 1 (commit a4d3604):
 * the add-to-failure-group / alarm-setpoints popovers (SensorSelection) and
 * the two colour popovers (HighlightsPanel) moved from expanding inline in
 * a scrolling list to `AnchoredPopover` + `Portal` (position: fixed,
 * portaled into `#wizard-portal-root` on document.body).
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
 *     the popover itself (see the `it.fails` cases at the bottom).
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

describe('SensorSelection popovers through Portal — interaction seam', () => {
    describe('clicks INSIDE the portaled popover never reach the sensor row (React bubbles through portals)', () => {
        it('add-to-FG: a kind toggle fires its own handler, does NOT toggle the row\'s selection, and the popover stays open', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(folderButtons()[1]); // TAG2
            fireEvent.click(screen.getByTitle('Add Individual to Group A'));
            expect(props.onToggleSensorGroupKind).toHaveBeenCalledWith('TAG2', 1, 'individual');
            expect(props.onSensorChange).not.toHaveBeenCalled();
            expect(openPopovers()).toHaveLength(1);
        });

        it('add-to-FG: clicking the heading, the new-group input and the Rename pencil never toggle the row', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]); // TAG1
            fireEvent.click(screen.getByText('Add to failure group', { selector: '.fg-menu-heading' }));
            fireEvent.click(screen.getByPlaceholderText('New group name'));
            fireEvent.click(screen.getByTitle('Rename Group A'));
            expect(props.onSensorChange).not.toHaveBeenCalled();
            // Rename swapped the row into its edit field, still inside the
            // same (still open) popover.
            expect(openPopovers()).toHaveLength(1);
            expect(openPopovers()[0].contains(screen.getByDisplayValue('Group A'))).toBe(true);
        });

        it('add-to-FG: typing + Enter in the new-group input commits for the anchored sensor, without toggling its row', () => {
            const { props } = renderSensorSelection();
            fireEvent.click(folderButtons()[1]); // TAG2
            const input = screen.getByPlaceholderText('New group name');
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

        it('the popover content lives in #wizard-portal-root, outside the component\'s own DOM container', () => {
            const { container } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            const pop = openPopovers()[0];
            expect(container.contains(pop)).toBe(false);
            expect(portalRoot()!.contains(screen.getByPlaceholderText('New group name'))).toBe(true);
        });
    });

    describe('self-close on scroll/resize resets the component\'s own open state', () => {
        it('scrolling the sensor list closes the add-to-FG popover, clears the trigger\'s "on" state, and ONE click reopens it', () => {
            const { container } = renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            expect(openPopovers()).toHaveLength(1);
            expect(folderButtons()[0].classList.contains('on')).toBe(true);

            fireEvent.scroll(container.querySelector('.sensor-list-widget')!);
            expect(openPopovers()).toHaveLength(0);
            expect(folderButtons()[0].classList.contains('on')).toBe(false);

            fireEvent.click(folderButtons()[0]); // not a toggle-closed no-op
            expect(openPopovers()).toHaveLength(1);
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

        it('collapsing the component group unmounts the open popover (it is still a React child of the row)', () => {
            renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            expect(openPopovers()).toHaveLength(1);
            fireEvent.click(screen.getByText('Pump')); // collapse
            expect(openPopovers()).toHaveLength(0);
        });

        it('switching the menu from one sensor to another re-anchors it to the newly clicked button', () => {
            renderSensorSelection();
            const [b1, b2] = folderButtons();
            b1.getBoundingClientRect = () => ({ top: 100, bottom: 126, left: 300, right: 326, width: 26, height: 26, x: 300, y: 100, toJSON() {} }) as DOMRect;
            b2.getBoundingClientRect = () => ({ top: 200, bottom: 226, left: 300, right: 326, width: 26, height: 26, x: 300, y: 200, toJSON() {} }) as DOMRect;
            fireEvent.click(b1);
            expect(openPopovers()[0].style.top).toBe('132px');
            fireEvent.click(b2);
            expect(openPopovers()).toHaveLength(1);
            expect(openPopovers()[0].style.top).toBe('232px');
        });
    });

    // ── Known bugs (recorded, not fixed — app code is outside qa's zone) ──

    describe('known bugs', () => {
        // `.sensor-popover` is `max-height: min(70vh, 420px); overflow-y:
        // auto` (App.css), so the add-to-FG menu with ~10+ groups scrolls
        // internally. That scroll fires a `scroll` event on the popover
        // element itself, which AnchoredPopover's window-level
        // `capture: true` listener catches like any other scroll — so the
        // first wheel tick inside the menu closes it, and groups below the
        // fold (plus the "New group name" input at the very bottom) become
        // unreachable. Verified in Chromium (same engine as WebView2): a
        // scroll on an `overflow: auto` descendant is delivered to a window
        // capture listener.
        it.fails('scrolling INSIDE the add-to-FG popover (its own overflow-y: auto) does not close it', () => {
            const manyGroups: FailureGroup[] = [{ no: 0, name: 'Not in Group' }];
            for (let i = 1; i <= 15; i++) manyGroups.push({ no: i, name: `Group ${i}` });
            renderSensorSelection({ fgGroups: manyGroups });
            fireEvent.click(folderButtons()[0]);
            const pop = openPopovers()[0];
            fireEvent.scroll(pop);
            expect(openPopovers()).toHaveLength(1);
        });

        // Chromium dispatches a `scroll` event on an <input> whose text
        // scrolls horizontally because it overflows the visible width —
        // verified in Chromium for this sweep: typing 55 chars into an
        // 80px text input, and 7 digits ("1013250") into a 64px
        // number input, each queued a `scroll` event on the input that a
        // window capture listener received. So typing a long group name
        // here (the input is ~200px wide inside a 290px popover) closes the
        // popover mid-typing and discards nothing but the user's place —
        // the draft survives in state, but the menu vanishes under them.
        it.fails('typing a long name into "New group name" (the input scrolls horizontally) does not close the popover', () => {
            renderSensorSelection();
            fireEvent.click(folderButtons()[0]);
            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'Mechanical seal leakage on discharge side' } });
            fireEvent.scroll(input); // what Chromium fires once the text overflows
            expect(screen.queryByPlaceholderText('New group name')).not.toBeNull();
        });

        // Position is `top = anchor.bottom + 6` with no flip/clamp, and the
        // sensor list fills the panel to the bottom of the window. Opening
        // the menu on one of the lowest visible rows puts the whole popover
        // below the viewport edge — and since scrolling closes it, there is
        // no way to reach it. Before Phase 1 the menu expanded inline and
        // could simply be scrolled into view with the list.
        it.fails('a popover opened from a row near the bottom of the window stays (mostly) on screen', () => {
            renderSensorSelection();
            const btn = folderButtons()[1];
            const h = window.innerHeight;
            btn.getBoundingClientRect = () => ({ top: h - 30, bottom: h - 4, left: 300, right: 326, width: 26, height: 26, x: 300, y: h - 30, toJSON() {} }) as DOMRect;
            fireEvent.click(btn);
            const pop = openPopovers()[0];
            const top = parseFloat(pop.style.top);
            // At least ~120px of the menu must be inside the viewport (or
            // it must open upward, above the anchor).
            expect(top <= h - 120 || top < h - 30).toBe(true);
        });

        // The alarm and add-to-FG popovers are independent pieces of state,
        // so both can be open at once. Inline, they stacked one under the
        // other inside the row; now both are `position: fixed` at the same
        // `top` (bell and folder buttons share one row) and right-aligned to
        // buttons 28px apart, so the 290px FG menu sits almost exactly on
        // top of the 220px alarm list.
        it.fails('only one sensor-list popover is open at a time (two fixed popovers from one row overlap)', () => {
            renderSensorSelection();
            fireEvent.click(screen.getByTitle('Alarm setpoints')); // TAG1
            fireEvent.click(folderButtons()[0]); // TAG1
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
