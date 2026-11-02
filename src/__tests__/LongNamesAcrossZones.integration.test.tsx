import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * Long sensor names, across zones: what each worker's own tests cannot see.
 *  (1) a tag-name file with blank descriptions, through the import's own metadata building, into the Sensor panel, the
 *      picker and the tooltip rows (the only way left to get a tag-only project, now that the file is required);
 *  (2) a windowed list with a search and a selection together: what is picked is the real sensor, whichever row was on
 *      screen, and it stays picked when the search goes;
 *  (3) the real Build Model window with the real picker: the model's target counts in the predictor chips' set.
 * Everything is real except the Tauri boundary. jsdom has no layout: `stubNamesCut` says how long names measure.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    files: new Map<string, string>(),
    store: new Map<string, unknown>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, cb: (e: any) => void) => {
        (h.listeners[event] ??= new Set()).add(cb);
        return () => { h.listeners[event]?.delete(cb); };
    },
    emit: async (event: string, payload?: unknown) => {
        for (const cb of [...(h.listeners[event] ?? [])]) cb({ event, payload, id: 0 });
    },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    readTextFile: async (p: string) => {
        const v = h.files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    },
    writeTextFile: async (p: string, c: string) => { h.files.set(p, c); },
    rename: async (from: string, to: string) => { h.files.set(to, h.files.get(from)!); h.files.delete(from); },
    exists: async (p: string) => p === 'workspaces' || h.files.has(p),
    mkdir: async () => {},
    remove: async (p: string) => { h.files.delete(p); },
    BaseDirectory: { AppData: 'AppData' },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
    load: async () => ({
        get: async (k: string) => h.store.get(k),
        set: async (k: string, v: unknown) => { h.store.set(k, v); },
        save: async () => {},
    }),
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string) => {
        if (cmd === 'get_dataset_time_bounds') return { min: '2025-01-01T00:00:00', max: '2025-12-31T23:59:00' };
        return undefined;
    },
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined), onCloseRequested: vi.fn().mockResolvedValue(() => {}) }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class { static getByLabel = vi.fn().mockResolvedValue(null); once = vi.fn(); },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div data-testid="echarts-mock" /> }));

import SensorSelection from '../components/dashboard/SensorSelection';
import BuildModelWindow from '../components/windows/BuildModelWindow';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { SensorPickerMulti, SensorPickerSingle } from '../components/sensor/SensorPicker';
import { buildSensorLookup, plainSensorLookup, sensorInlineHtml } from '../components/sensor/sensorInfo';
import { tagFileBlockReason } from '../components/upload/setupHelpers';
import { buildSensorMetadataFromMapping } from '../hooks/useMappingData';
import { tooltipSharedPrefix } from '../utils/tooltipLayout';
import { emit } from '@tauri-apps/api/event';
import { longName, restoreNames, stubNamesCut, stubNamesFit } from './helpers/nameGeometry';
import { openPickerSurface, pickerRows, pickerSearch } from './helpers/sensorPicker';
import { ALL_TIME_TRAIN, rcOn } from './helpers/trainTestFixture';
import type { FailureGroup, FailureModel, SensorMetadata } from '../types';

const SHARED = 'Crosshead (P-P Trend) - Vibration crosshead slide 11A';

const panelProps = (sensors: string[], sensorMetadata: SensorMetadata[] | null) => ({
    sensors,
    selectedSensors: [] as string[],
    onSensorChange: vi.fn(),
    sensorMetadata,
    fgGroups: [{ no: 0, name: 'Not in Group' }] as FailureGroup[],
    fgModels: [] as FailureModel[],
    getGroupColor: () => 'blue',
    onToggleSensorGroupKind: vi.fn(),
    onCreateGroupForSensor: vi.fn(),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    alarmLinesEnabled: {} as Record<string, any>,
    onToggleAlarmLine: vi.fn(),
});

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.files.clear();
    h.store.clear();
});

afterEach(() => {
    restoreNames();
    vi.unstubAllGlobals();
    cleanup();
    document.getElementById('wizard-portal-root')?.remove();
});

describe('(1) a tag-name file with every description blank: a tag-only project from import to screen', () => {
    const tags = [longName(1), longName(2), longName(3)];
    const mappingData = { headers: ['tag', 'description', 'unit', 'component'], rows: tags.map(t => [t, '', 'mm/s', 'Crosshead']) };
    const mappingResult = { matched: tags, not_in_dataset: [], not_in_mapping: [] };
    const metadata = () => buildSensorMetadataFromMapping(mappingData as any, mappingResult as any, 'tag')!;

    it('passes the step-2 check and keeps the unit and component of each row', () => {
        expect(tagFileBlockReason('/tags.csv', 'tag', mappingResult as any)).toBeNull();
        expect(metadata().map(m => [m.description, m.unit, m.component])).toEqual(tags.map(() => ['', 'mm/s', 'Crosshead']));
    });

    it('Sensor panel: the tags are the names, they join one run, and no row prints its tag twice', () => {
        stubNamesCut();
        const { container } = render(<SensorSelection {...panelProps(tags, metadata())} />);
        fireEvent.click(screen.getByText('Crosshead'));
        const lines = screen.getAllByTestId('sensor-run-prefix');
        expect(lines).toHaveLength(1);
        expect(lines[0].textContent).toBe(`${SHARED} …`);
        const rows = [...container.querySelectorAll('.sensor-list-row')];
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.querySelector('.sl-tag')).toBeNull();
            expect(row.querySelector('.sl--notag')).toBeTruthy();
        }
        expect(new Set(rows.map(r => r.querySelector('.sl-desc')!.textContent)).size).toBe(3);
    });

    it('picker: a search reaches the end of the tag, and the pick is the whole tag, not the printed part', () => {
        stubNamesCut();
        const onSelect = vi.fn();
        render(
            <SensorMetaProvider metadata={metadata()}>
                <SensorPickerSingle sensors={tags} value="" onSelect={onSelect} ariaLabel="Y sensor" />
            </SensorMetaProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Y sensor' }));
        fireEvent.change(pickerSearch(), { target: { value: 'SegmentNo 2' } });
        const rows = pickerRows();
        expect(rows).toHaveLength(1);
        fireEvent.click(rows[0]);
        expect(onSelect).toHaveBeenCalledWith(tags[1]);
    });

    it('tooltip rows: the tag is printed once, in its mono form, and the start is shared across the rows', () => {
        const lookup = buildSensorLookup(plainSensorLookup, metadata());
        const infos = tags.map(lookup);
        const prefix = tooltipSharedPrefix(infos);
        expect(prefix).toBe(SHARED);
        const html = sensorInlineHtml(infos[1], '#fff', '1.5 mm/s', prefix);
        const row = document.createElement('div');
        row.innerHTML = html;
        expect(row.textContent).toContain('SegmentNo 2 - avg');
        expect(row.textContent).not.toContain('Crosshead');
        expect(row.querySelectorAll('.tt-desc.tt-mono')).toHaveLength(1);
        expect(row.querySelector('.tt-tag')).toBeNull();
    });
});

describe('(2) a windowed list with a search and a selection together', () => {
    const COUNT = 4748;
    const tags = Array.from({ length: COUNT }, (_, i) => longName(i));
    const meta: SensorMetadata[] = tags.map(tag => ({ tag, description: tag.replace('SegmentNo', 'Segment No'), unit: 'mm/s', component: 'Crosshead' }));

    function Panel({ onChange }: { onChange: (s: string[]) => void }) {
        const [selectedSensors, set] = useState<string[]>([]);
        return <SensorSelection {...panelProps(tags, meta)} selectedSensors={selectedSensors} onSensorChange={s => { set(s); onChange(s); }} />;
    }
    const search = (value: string) => fireEvent.change(screen.getByPlaceholderText('Search description, tag, unit or component…'), { target: { value } });
    const checkbox = (container: HTMLElement, end: string) => {
        const row = [...container.querySelectorAll('.sensor-list-row')].find(r => r.textContent!.includes(end));
        return row?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
    };

    it('Sensor panel: a row picked during a search is the right sensor, and is still picked once the search is gone and it is scrolled to', () => {
        stubNamesCut();
        const onChange = vi.fn();
        const { container } = render(<Panel onChange={onChange} />);
        search('Segment No 4000 ');
        expect(container.querySelectorAll('.sensor-list-row')).toHaveLength(1);
        fireEvent.click(checkbox(container, '4000')!);
        expect(onChange).toHaveBeenLastCalledWith([longName(4000)]);

        search('');
        fireEvent.click(screen.getByText('Crosshead'));
        const list = container.querySelector('.sensor-list-widget') as HTMLElement;
        expect(checkbox(container, 'Segment No 4000 ')).toBeUndefined();
        expect(container.querySelectorAll('.sensor-list-row').length).toBeLessThan(60);

        // Dragging the scrollbar lands among rows not measured yet: go to about where the row is, then step to it.
        const height = parseFloat(screen.getByTestId('sensor-list-window').style.height);
        const near = Math.floor(height * (4000 / COUNT));
        for (let step = 0; step < 12 && !checkbox(container, 'Segment No 4000 '); step++) {
            list.scrollTop = near + (step % 2 ? -1 : 1) * Math.ceil(step / 2) * 600;
            fireEvent.scroll(list);
        }
        expect(checkbox(container, 'Segment No 4000 ')?.checked).toBe(true);
        expect(container.querySelectorAll('.sensor-list-row').length).toBeLessThan(60);
    });

    it('Sensor panel: rows of different runs picked during a search add up, and each name is the sensor it says', () => {
        const onChange = vi.fn();
        const { container } = render(<Panel onChange={onChange} />);
        search('Segment No 11 ');
        fireEvent.click(checkbox(container, 'Segment No 11 ')!);
        search('Segment No 4747 ');
        fireEvent.click(checkbox(container, 'Segment No 4747 ')!);
        expect(onChange).toHaveBeenLastCalledWith([longName(11), longName(4747)]);
    });

    it('"Add…" modal: rows picked far apart in a windowed search come back as those sensors; OK writes both', () => {
        stubNamesCut();
        const onConfirm = vi.fn();
        render(
            <SensorMetaProvider metadata={meta}>
                <SensorPickerMulti sensors={tags} selected={[]} onConfirm={onConfirm} noun="predictors" />
            </SensorMetaProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: /add/i }));
        fireEvent.change(pickerSearch(), { target: { value: 'crosshead' } });
        const list = openPickerSurface().querySelector('.pk-list') as HTMLElement;
        expect(list.className).toContain('pk-list--windowed');
        expect(pickerRows().length).toBeLessThan(40);

        const rowFor = (n: number) => pickerRows().find(r => r.getAttribute('title')!.includes(`Segment No ${n} `));
        fireEvent.click(rowFor(2)!);
        list.scrollTop = 4000 * 30;
        fireEvent.scroll(list);
        expect(pickerRows().length).toBeLessThan(40);
        const far = pickerRows()[5];
        const farN = Number(/Segment No (\d+) /.exec(far.getAttribute('title')!)![1]);
        fireEvent.click(far);
        fireEvent.click(within(openPickerSurface()).getByRole('button', { name: 'OK' }));
        expect(onConfirm).toHaveBeenCalledWith([longName(2), longName(farN)]);
    });
});

describe('(3) the real Build Model window: the target counts in the chips\' set', () => {
    const WS_FILE = 'workspaces/ws1.json';
    const name = (slide: string, seg: number, end: string) => `Crosshead (P-P Trend) - Vibration crosshead slide ${slide} - SegmentNo ${seg} - ${end}`;
    const TARGET = name('11A', 1, 'avg');
    const P1 = name('11B', 1, 'avg');
    const P2 = name('11B', 1, 'max');
    const OTHER = name('11A', 1, 'max');
    const HEADERS = [TARGET, P1, P2, OTHER, 'KW'];
    const sensorMetadata: SensorMetadata[] = HEADERS.map(tag => ({ tag, description: tag === 'KW' ? 'Power' : tag.replace('SegmentNo', 'Segment No'), unit: 'mm/s', component: 'Crosshead' }));
    const model = (o: Record<string, unknown>) => ({
        id: 'x', groupNos: [1], name: 'Model', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: '', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 1, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [],
        customRunningConditionCombine: 'and', customRunningConditionNoneConfirmed: false,
        ...o,
    });
    const REL = model({ id: 'r1', kind: 'relationship', targetSensor: TARGET, predictorSensors: [P1, P2] });

    async function mount(models: unknown[]) {
        h.files.set(WS_FILE, JSON.stringify({
            id: 'ws1', name: 'LN', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
            selectedSensors: [], visibleSensors: [], operationConfig: null,
            failureGroupState: {
                groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG long' }],
                models, runningConditionFilters: [rcOn('KW')], runningConditionCombine: 'and', runningConditionTimePeriods: ALL_TIME_TRAIN,
                rcLegacyNotice: null, categoryNormalisationNotice: null,
            },
        }));
        const data = { workspaceId: 'ws1', sensorHeaders: HEADERS, sensorMetadata, metadata: { headers: ['timestamp', ...HEADERS], total_rows: 100 } };
        h.listeners['request-build-model-data'] = new Set([() => { void emit('build-model-data', data); }]);
        render(<BuildModelWindow />);
        await waitFor(() => expect(screen.getByTestId('rc-card')).toBeTruthy());
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    }
    const openSettings = () => {
        if (!screen.queryByTestId('add-model-form')) fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
    };

    it('chips that share "11B" with each other keep it when cut, because the target above them is "11A"', async () => {
        stubNamesCut();
        await mount([REL]);
        openSettings();
        const chips = [...document.querySelectorAll('.pk-chip')].map(c => c.textContent!);
        expect(chips).toHaveLength(2);
        // Without the target in the set the shared start would swallow "11B" and the chips would read "avg" / "max".
        for (const chip of chips) expect(chip).toContain('11B');
        expect(chips[0]).toContain('avg');
        expect(chips[1]).toContain('max');
        expect(new Set(chips).size).toBe(2);
    });

    it('(control) the same two chips with no target on the card lose "11B" to the shared start line', () => {
        stubNamesCut();
        render(
            <SensorMetaProvider metadata={sensorMetadata}>
                <SensorPickerMulti sensors={HEADERS} selected={[P1, P2]} onConfirm={() => {}} noun="predictors" />
            </SensorMetaProvider>,
        );
        expect(screen.getByTestId('chip-prefix').textContent).toContain('11B');
        for (const chip of document.querySelectorAll('.pk-chip')) expect(chip.textContent).not.toContain('11B');
    });

    it('long names measured as fitting: chips and list row are whole, with no shared line', async () => {
        stubNamesFit();
        await mount([REL]);
        openSettings();
        expect(screen.queryByTestId('chip-prefix')).toBeNull();
        expect(screen.queryByTestId('list-group-prefix')).toBeNull();
        const chips = [...document.querySelectorAll('.pk-chip .sl-desc')].map(c => c.textContent);
        expect(chips).toEqual([P1.replace('SegmentNo', 'Segment No'), P2.replace('SegmentNo', 'Segment No')]);
        // The tag only re-spells the description, so no chip has a tag line (rule 3b) even with room for it.
        expect(document.querySelector('.pk-chip .sl-tag')).toBeNull();
    });

    it('the list groups a target and a Clustering X in one set and rows read differently; a picked predictor is the whole tag on disk', async () => {
        stubNamesCut();
        await mount([REL, model({ id: 'c1', kind: 'clustering', xSensor: OTHER, ySensor: TARGET })]);
        const rows = screen.getAllByTestId('sensor-row-label').map(r => r.textContent);
        expect(rows).toHaveLength(2);
        expect(new Set(rows).size).toBe(2);
        const line = screen.getByTestId('list-group-prefix').textContent!;
        expect(line.startsWith('Crosshead (P-P Trend)')).toBe(true);

        openSettings();
        const add = screen.getAllByRole('button', { name: /^Add/ }).find(b => b.closest('.pk-multi'))!;
        fireEvent.click(add);
        fireEvent.change(pickerSearch(), { target: { value: 'slide 11A - SegmentNo 1 - max' } });
        fireEvent.click(pickerRows()[0]);
        fireEvent.click(within(openPickerSurface()).getByRole('button', { name: 'OK' }));
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await waitFor(() => {
            const saved = JSON.parse(h.files.get(WS_FILE)!).failureGroupState.models.find((m: any) => m.id === 'r1');
            expect(saved.predictorSensors).toEqual([P1, P2, OTHER]);
        });
    });
});
