import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: mockClose }),
}));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {
        listenCallbacks[event] = (listenCallbacks[event] ?? []).filter((c) => c !== cb);
    });
});
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
    emit: (event: string, payload?: any) => mockEmit(event, payload),
}));

const mockLoadWorkspaceData = vi.fn();
vi.mock('../workspaceManager', () => ({
    loadWorkspaceData: (id: string) => mockLoadWorkspaceData(id),
}));

import BuildModelOverviewWindow from '../components/windows/BuildModelOverviewWindow';

function makeGroup(overrides: Record<string, any> = {}) {
    return { no: 1, name: 'Group A', isCollapsed: false, description: '', recommendation: '', ...overrides };
}

function makeModel(overrides: Record<string, any> = {}) {
    return {
        id: 'm1', groupNo: 1, name: 'Model One', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
        ...overrides,
    };
}

async function deliverData(overrides: Record<string, any> = {}) {
    const payload = {
        workspaceId: 'ws1',
        sensorMetadata: [
            { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Motor' },
        ],
    };
    mockLoadWorkspaceData.mockResolvedValue({
        id: 'ws1',
        failureGroupState: { groups: [makeGroup()], models: [makeModel()] },
        ...overrides,
    });
    await act(async () => {
        for (const cb of listenCallbacks['build-model-overview-data'] ?? []) cb({ payload });
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockLoadWorkspaceData.mockReset();
});

afterEach(() => {
    cleanup();
});

describe('BuildModelOverviewWindow', () => {
    it('requests build-model-overview-data on mount', async () => {
        render(<BuildModelOverviewWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-build-model-overview-data', undefined);
    });

    it('shows header stats and the group once hydrated', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        expect(screen.getByText('Group A')).toBeTruthy();
        expect(screen.getByText('FG-1')).toBeTruthy();
        expect(screen.getByText('Model One')).toBeTruthy();
    });

    it('shows exactly one line per model — no duplicate description/description(tag) lines', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: '', targetSensor: 'TAG1' })] } });
        expect(screen.getAllByText('Pump Pressure (TAG1)')).toHaveLength(1);
    });

    it('treats a name identical to its own target tag as unset (legacy-migrated models) and falls back to "description (tag)"', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: 'TAG1', targetSensor: 'TAG1' })] } });
        expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        expect(screen.queryByText('TAG1')).toBeNull();
    });

    it('falls back to "Untitled model" for a model with no name and no sensor picked yet', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: '', targetSensor: '' })] } });
        expect(screen.getByText('Untitled model')).toBeTruthy();
    });

    it('defaults to grouping by Failure Group', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        expect(screen.queryByText('Uncategorized')).toBeNull();
        expect(screen.getByText('Group A')).toBeTruthy();
    });

    it('switches to grouping by Component and shows each model\'s component as a section', async () => {
        const models = [
            makeModel({ id: 'm1', name: 'Bearing model', targetSensor: 'TAG1' }),
            makeModel({ id: 'm2', name: 'Motor model', targetSensor: 'TAG2' }),
        ];
        render(<BuildModelOverviewWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models } });

        fireEvent.click(screen.getByText('Group by Component'));
        expect(screen.getByText('Pump')).toBeTruthy();
        expect(screen.getByText('Motor')).toBeTruthy();
        expect(screen.getByText('Bearing model')).toBeTruthy();
        expect(screen.getByText('Motor model')).toBeTruthy();
    });

    it('shows an FG-{no} chip on each model row only in Component view, not in Failure Group view', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        expect(screen.queryByText(/FG-1 · Group A/)).toBeNull();

        fireEvent.click(screen.getByText('Group by Component'));
        expect(screen.getByText(/FG-1 · Group A/)).toBeTruthy();
    });

    it('groups a model with no target sensor under "Uncategorized" in Component view', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ targetSensor: '' })] } });
        fireEvent.click(screen.getByText('Group by Component'));
        expect(screen.getByText('Uncategorized')).toBeTruthy();
    });

    it('clicking a Failure Group section header opens that group\'s Build Model window', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        mockEmit.mockClear();
        fireEvent.click(screen.getByText('Group A'));
        expect(mockEmit).toHaveBeenCalledWith('open-build-model', { groupNo: 1 });
    });

    it('clicking a model row opens that model\'s group\'s Build Model window', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        mockEmit.mockClear();
        fireEvent.click(screen.getByText('Model One'));
        expect(mockEmit).toHaveBeenCalledWith('open-build-model', { groupNo: 1 });
    });

    it('stays in sync with a failure-group-state-changed broadcast from another window', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        expect(screen.queryByText('New Model')).toBeNull();

        await act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                cb({ payload: { groups: [makeGroup()], models: [makeModel({ id: 'm2', name: 'New Model' })] } });
            }
        });
        expect(screen.getByText('New Model')).toBeTruthy();
    });

    it('Close calls the Tauri window close API', async () => {
        render(<BuildModelOverviewWindow />);
        await deliverData();
        fireEvent.click(screen.getByTitle('Close'));
        expect(mockClose).toHaveBeenCalled();
    });
});
