import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/*
 * Spec: docs/design/handoff/dashboard-tagged-points/README.md (layout of the "Tagged points"
 * tab) on top of the tab itself (the values of the points tagged on the chart live in the
 * Dashboard's bottom panel, not on the chart).
 *
 * The two halves are tested apart, each against a stand-in for the other:
 *   - `Dashboard.test.tsx` ("Tagged points tab") mocks the whole chart and calls
 *     `onTagCountChange` / reads `tagTableHost` by hand;
 *   - `LineChart.test.tsx` / `TagCompareTable.test.tsx` render the chart with a bare <div>
 *     as the host and metadata passed as a prop.
 *
 * Nothing mounts the REAL Dashboard with the REAL Line chart, so nothing checks what the user
 * actually sees after clicking the chart: the table of that chart, portalled INTO the
 * Dashboard's tab, with the sensor names / units that reach it through the Dashboard, the
 * count in the tab's name, and the tab changing by itself only when a point was just tagged.
 * The 2026-10-12 layout pass also changed what the chart hands the table (`tagCell(text)` no
 * longer takes the unit — it is printed once per row from the sensor's metadata), which is
 * exactly the kind of change that only fails where the two meet.
 */

// ── a fake ECharts instance: enough for the Line chart's Tag tool (zrender click → nearest point) ──
const chartOptions: any[] = [];
let zrClick: ((e: { offsetX: number; offsetY: number }) => void) | null = null;
const convertFromPixel = vi.fn((): [number, number] => [0, 0]);
const fakeChart = {
    getZr: () => ({ on: (evt: string, cb: (e: any) => void) => { if (evt === 'click') zrClick = cb; }, off: vi.fn() }),
    containPixel: () => true,
    convertFromPixel,
    dispatchAction: vi.fn(),
};
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => {
        chartOptions.push(props.option);
        // eslint-disable-next-line react-hooks/rules-of-hooks
        useEffect(() => { props.onChartReady?.(fakeChart); }, []);
        return <div data-testid="echarts" />;
    },
}));
// The Scatter / Pair Plot charts are imported with the Line chart; they are never drawn here.
vi.mock('regl-scatterplot', () => ({ default: () => ({ destroy: vi.fn(), draw: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn(), unsubscribe: vi.fn(), set: vi.fn(), get: vi.fn() }) }));

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/healthEnv')).windowModule());
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class { static getByLabel = vi.fn().mockResolvedValue(null); once = vi.fn(); },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn().mockResolvedValue(undefined) }));
vi.mock('split.js', () => ({ default: () => ({ destroy: vi.fn() }) }));
vi.mock('../errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../components/dashboard/FilterPanel', () => ({ default: () => <div data-testid="filter-panel" /> }));
vi.mock('../components/dashboard/HighlightsPanel', () => ({ default: () => <div data-testid="highlights-panel" /> }));
vi.mock('../components/dashboard/ColorPlatePicker', () => ({ default: () => <div /> }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));

// What Rust's `get_chart_data` would answer for the two sensors on the plot: 10 rows, 5 minutes
// apart; TAG3 has NO value in row 3.
const STAMPS = Array.from({ length: 10 }, (_, i) => `2026-04-23T15:${String(i * 5).padStart(2, '0')}:00`);
const VIEW = {
    headers: ['TAG1', 'TAG3'],
    timestamps: STAMPS,
    series: [
        [61.5, 62.25, 63, 64.125, 65, 66, 67.5, 68, 69.25, 70],
        [40, 41.5, 43, null, 46, 47.5, 49, 50.5, 52, 53.5],
    ] as (number | null)[][],
    total_rows: 10,
    ts_min: STAMPS[0],
    ts_max: STAMPS[9],
};
vi.mock('../hooks/useChartData', () => ({ useChartData: () => ({ view: VIEW, loading: false, error: null }) }));

import Dashboard from '../components/dashboard/Dashboard';
import { resetEnv } from './helpers/healthEnv';
import { PLANT_META } from './helpers/fakeHealthRust';
import { HEADERS, newBackend, readDisk, settle, writeDisk, wsState } from './helpers/healthWorkbench';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    chartOptions.length = 0;
    zrClick = null;
    convertFromPixel.mockReset();
    if (!(globalThis as any).ResizeObserver) {
        (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ms = (ts: string) => new Date(ts).getTime();

async function mountDashboard() {
    writeDisk({ ...wsState({ models: [] }), selectedSensors: ['TAG1', 'TAG3'], visibleSensors: ['TAG1', 'TAG3'] });
    const ui = render(
        <Dashboard
            metadata={{ headers: HEADERS, total_rows: 10, generation: 1 } as any}
            sensorMetadata={PLANT_META as any}
            onBack={vi.fn()}
            initialState={readDisk()}
        />,
    );
    await settle(50);
    return ui;
}

/** The bottom panel's tab button whose name starts with `name`. */
const tab = (name: string) => screen.getAllByRole('button').find(b => b.textContent?.startsWith(name))!;
const tagsTab = () => tab('Tagged points');
const tagTool = (root: HTMLElement) => root.querySelector('[title^="Tag point"]') as HTMLElement;
/** Click the chart at the row of `STAMPS[row]` (what zrender reports for a click in the plot). */
function clickChartAt(row: number) {
    convertFromPixel.mockReturnValue([ms(STAMPS[row]), 0]);
    act(() => { zrClick!({ offsetX: 100 + row * 40, offsetY: 80 }); });
}
/** The tags drawn on the chart (the mark points of the first series of the latest option). */
const chartTags = (): number[] => (chartOptions[chartOptions.length - 1].series[0].markPoint?.data ?? []).map((d: any) => d.coord[0]);
const host = () => screen.getByTestId('tag-panel-host');
const table = () => within(host()).getByTestId('tag-table');
const heads = () => within(within(table()).getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem');
const names = () => within(table()).getAllByTestId('tag-table-name');
const vals = () => within(table()).getAllByTestId('tag-table-val').map(v => v.textContent);

describe('Dashboard "Tagged points" tab × the real Line chart: a click on the chart ends up as a column of the tab\'s table', () => {
    it('nothing tagged: the tab is there with no count; opening it says how to tag and shows no table — and no table sits under the chart', async () => {
        const { container } = await mountDashboard();
        expect(tagsTab().textContent).toBe('Tagged points');
        expect(screen.queryByTestId('tag-table')).toBeNull();
        fireEvent.click(tagsTab());
        expect(screen.getByTestId('tag-panel-empty').textContent).toMatch(/^No tagged points yet — turn on the Tag tool/);
        expect(host().children).toHaveLength(0);
        // the chart itself shows the two sensors, with nothing tagged
        expect(chartOptions[chartOptions.length - 1].series).toHaveLength(2);
        expect(chartTags()).toEqual([]);
        expect(tagTool(container)).toBeTruthy();
    });

    it('tagging a point switches the panel to "Tagged points (1)" by itself and the chart\'s table is INSIDE the tab: one row per sensor (description, tag, unit ONCE), one column for the tag, the bare number per cell', async () => {
        const { container } = await mountDashboard();
        fireEvent.click(tab('Filter'));
        expect(screen.getByTestId('filter-panel')).toBeTruthy();
        fireEvent.click(tagTool(container));
        clickChartAt(1);
        await settle(0);

        // the panel followed the click: from Filter to the tags tab, with the count in its name
        expect(tagsTab().textContent).toBe('Tagged points (1)');
        expect(screen.queryByTestId('filter-panel')).toBeNull();
        expect(screen.queryByTestId('tag-panel-empty')).toBeNull();
        // ONE table, and it is in the tab — not under the chart
        expect(screen.getAllByTestId('tag-table')).toHaveLength(1);
        expect(host().contains(table())).toBe(true);
        expect(table().className).toContain('tag-table--panel');
        expect(container.querySelector('.chart-section-large')!.contains(table()), 'not under the chart').toBe(false);
        // on the chart: one dot at that time, no value box
        expect(chartTags()).toEqual([ms(STAMPS[1])]);

        // rows: the sensors of the plot, named by the Dashboard's metadata; the unit ONCE, in the name cell
        expect(names()).toHaveLength(2);
        expect(names()[0].textContent).toBe('Pump PressureTAG1bar');
        expect(within(names()[0]).getByTestId('tag-table-unit').textContent).toBe('bar');
        expect(names()[1].textContent).toBe('FlowTAG3m3/h');
        expect(within(names()[1]).getByTestId('tag-table-unit').textContent).toBe('m3/h');
        // cells: the number alone (no unit repeated per cell)
        expect(vals()).toEqual(['62.250', '41.500']);
        for (const v of vals()) expect(v).not.toMatch(/bar|m3/);
        // the column head: date over time (two parts, one readable stamp), its own ×
        expect(heads()).toHaveLength(1);
        expect(heads()[0].querySelector('.chart-tag-date')!.textContent).toBe('2026/04/23');
        expect(heads()[0].querySelector('.chart-tag-time')!.textContent).toBe('15:05:00');
        expect(heads()[0].querySelector('.chart-tag-label')!.textContent).toBe('2026/04/23 15:05:00');
        expect(within(heads()[0]).getByRole('button').getAttribute('aria-label')).toMatch(/^Remove tag .* 2026\/04\/23 15:05:00$/);
        // the footer of the tab
        expect(table().textContent).toContain('1 of 8 points');
        // the hint under the toolbar points at the tab
        expect(container.textContent).toContain('its values are listed in the Tagged points tab');
    });

    it('more tags = more columns in tag order; a sensor with no value there reads "—"; the head dot is the colour of the marker on the chart', async () => {
        const { container } = await mountDashboard();
        fireEvent.click(tagTool(container));
        clickChartAt(1);
        clickChartAt(3); // TAG3 has no value in this row
        clickChartAt(5);
        await settle(0);
        expect(tagsTab().textContent).toBe('Tagged points (3)');
        expect(heads().map(h => h.querySelector('.chart-tag-time')!.textContent)).toEqual(['15:05:00', '15:15:00', '15:25:00']);
        // row by row: TAG1 then TAG3
        expect(vals()).toEqual(['62.250', '64.125', '66.000', '41.500', '—', '47.500']);
        expect(table().textContent).toContain('3 of 8 points');
        // the tags are told apart by colour only, and the colours match the chart's markers
        const markerColours = chartOptions[chartOptions.length - 1].series[0].markPoint.data.map((d: any) => d.itemStyle.color);
        expect(new Set(markerColours).size).toBe(3);
        const headColours = heads().map(h => (h as HTMLElement).style.getPropertyValue('--tag-c'));
        expect(headColours).toEqual(markerColours);
        for (const h of heads()) expect(h.querySelector('.chart-tag-dot')!.textContent).toBe('');
    });

    it('leaving the tab takes the table away but not the tags; coming back does not need a new click; × removes ONE tag on the chart and in the count', async () => {
        const { container } = await mountDashboard();
        fireEvent.click(tagTool(container));
        clickChartAt(0);
        clickChartAt(2);
        clickChartAt(4);
        await settle(0);
        expect(tagsTab().textContent).toBe('Tagged points (3)');

        // another tab: no table anywhere, the chart keeps its three tags, the count stays in the tab's name
        fireEvent.click(tab('Highlights'));
        expect(screen.getByTestId('highlights-panel')).toBeTruthy();
        expect(screen.queryByTestId('tag-table')).toBeNull();
        expect(screen.queryByTestId('tag-panel-host')).toBeNull();
        expect(chartTags()).toEqual([ms(STAMPS[0]), ms(STAMPS[2]), ms(STAMPS[4])]);
        expect(tagsTab().textContent).toBe('Tagged points (3)');

        // back: the same three columns
        fireEvent.click(tagsTab());
        expect(heads().map(h => h.querySelector('.chart-tag-time')!.textContent)).toEqual(['15:00:00', '15:10:00', '15:20:00']);
        const colourOf = (i: number) => (heads()[i] as HTMLElement).style.getPropertyValue('--tag-c');
        const [, c2, c3] = [colourOf(0), colourOf(1), colourOf(2)];

        // × of the FIRST column: only that tag goes — on the chart, in the table, in the count; the others keep their colour
        await act(async () => { fireEvent.click(within(heads()[0]).getByRole('button')); });
        expect(tagsTab().textContent).toBe('Tagged points (2)');
        expect(chartTags()).toEqual([ms(STAMPS[2]), ms(STAMPS[4])]);
        expect(heads().map(h => h.querySelector('.chart-tag-time')!.textContent)).toEqual(['15:10:00', '15:20:00']);
        expect([colourOf(0), colourOf(1)]).toEqual([c2, c3]);
        expect(vals()).toEqual(['63.000', '65.000', '43.000', '46.000']);
        // a removal never pulls the user to another tab (it is not "a point was just tagged")
        fireEvent.click(tab('Filter'));
        expect(tagsTab().textContent).toBe('Tagged points (2)');
        expect(screen.getByTestId('filter-panel')).toBeTruthy();

        // remove the rest from the tab: the table is replaced by the empty text, the count leaves the name
        fireEvent.click(tagsTab());
        await act(async () => { fireEvent.click(within(heads()[0]).getByRole('button')); });
        await act(async () => { fireEvent.click(within(heads()[0]).getByRole('button')); });
        expect(tagsTab().textContent).toBe('Tagged points');
        expect(screen.queryByTestId('tag-table')).toBeNull();
        expect(screen.getByTestId('tag-panel-empty')).toBeTruthy();
        expect(chartTags()).toEqual([]);
    });

    it('the chart holds 8 tags at most: the tab says so at the limit, the ninth click adds nothing anywhere, and removing one makes room again', async () => {
        const { container } = await mountDashboard();
        fireEvent.click(tagTool(container));
        for (const row of [0, 1, 2, 3, 4, 5, 6, 7]) clickChartAt(row);
        await settle(0);
        expect(tagsTab().textContent).toBe('Tagged points (8)');
        expect(heads()).toHaveLength(8);
        expect(table().textContent).toContain('8 of 8 points · the chart holds 8 at most — remove one to tag another');
        // every column's values are the ones of ITS row (no column shifted against its head)
        const v = vals();
        expect(v).toHaveLength(16);
        expect(v.slice(0, 8)).toEqual(VIEW.series[0].slice(0, 8).map(x => (x as number).toFixed(3)));
        expect(v.slice(8)).toEqual(VIEW.series[1].slice(0, 8).map(x => (x === null ? '—' : x.toFixed(3))));

        // a ninth click: nothing changes on the chart, in the table or in the tab's name
        clickChartAt(8);
        await settle(0);
        expect(chartTags()).toHaveLength(8);
        expect(heads()).toHaveLength(8);
        expect(tagsTab().textContent).toBe('Tagged points (8)');

        // remove one → there is room: the same click now tags row 8, as the LAST column
        await act(async () => { fireEvent.click(within(heads()[2]).getByRole('button')); });
        expect(tagsTab().textContent).toBe('Tagged points (7)');
        expect(table().textContent).toContain('7 of 8 points');
        expect(table().textContent).not.toContain('remove one to tag another');
        clickChartAt(8);
        await settle(0);
        expect(tagsTab().textContent).toBe('Tagged points (8)');
        expect(heads().map(h => h.querySelector('.chart-tag-time')!.textContent)).toEqual(
            ['15:00:00', '15:05:00', '15:15:00', '15:20:00', '15:25:00', '15:30:00', '15:35:00', '15:40:00']);
        expect(chartTags()[7]).toBe(ms(STAMPS[8]));
        expect(vals()[7]).toBe('69.250');
    });
});
