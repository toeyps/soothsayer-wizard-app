import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockSave = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: (...args: unknown[]) => mockSave(...args),
}));

const mockWriteUserBinaryFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../workspaceManager', () => ({
    writeUserBinaryFile: (...args: unknown[]) => mockWriteUserBinaryFile(...args),
}));

const mockToPng = vi.fn();
vi.mock('html-to-image', () => ({
    toPng: (...args: unknown[]) => mockToPng(...args),
}));

// No child <div>s are placed under the captured node in these tests, so
// `collectECharts` never iterates any elements and getInstanceByDom is never
// actually invoked — this keeps the composite-canvas branch (which jsdom
// can't render) entirely out of the picture; captureNodeFull short-circuits
// to the raw toPng() result whenever there are zero chart captures.
const mockGetInstanceByDom = vi.fn((_container?: unknown) => undefined);
vi.mock('echarts', () => ({
    getInstanceByDom: (container: unknown) => mockGetInstanceByDom(container),
    init: vi.fn(),
}));

import { usePMReport } from '../hooks/usePMReport';

beforeEach(() => {
    mockSave.mockReset();
    mockWriteUserBinaryFile.mockReset().mockResolvedValue(undefined);
    mockToPng.mockReset();
    mockGetInstanceByDom.mockReset().mockReturnValue(undefined);
});

describe('usePMReport', () => {
    describe('exportPNG', () => {
        it('does nothing when the user cancels the save dialog', async () => {
            mockSave.mockResolvedValue(null);
            const { result } = renderHook(() => usePMReport());
            const node = document.createElement('div');

            await result.current.exportPNG(node, 'My Workspace');

            expect(mockToPng).not.toHaveBeenCalled();
            expect(mockWriteUserBinaryFile).not.toHaveBeenCalled();
        });

        it('captures the node and writes the decoded PNG bytes to the chosen path', async () => {
            mockSave.mockResolvedValue('C:/reports/out.png');
            mockToPng.mockResolvedValue('data:image/png;base64,aGVsbG8='); // "hello"
            const { result } = renderHook(() => usePMReport());
            const node = document.createElement('div');

            await result.current.exportPNG(node, 'My Workspace');

            expect(mockSave).toHaveBeenCalledWith(
                expect.objectContaining({
                    defaultPath: expect.stringMatching(/^wizard-report-My-Workspace-\d{4}-\d{2}-\d{2}\.png$/),
                    filters: [{ name: 'PNG Image', extensions: ['png'] }],
                }),
            );
            expect(mockWriteUserBinaryFile).toHaveBeenCalledTimes(1);
            const [path, bytes] = mockWriteUserBinaryFile.mock.calls[0];
            expect(path).toBe('C:/reports/out.png');
            expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('hello');
        });

        it('sanitizes the workspace name for the default filename', async () => {
            mockSave.mockResolvedValue('C:/reports/out.png');
            mockToPng.mockResolvedValue('data:image/png;base64,aGVsbG8=');
            const { result } = renderHook(() => usePMReport());
            const node = document.createElement('div');

            await result.current.exportPNG(node, 'Weird / Name*?');

            const call = mockSave.mock.calls[0][0];
            expect(call.defaultPath).toMatch(/^wizard-report-Weird-Name-\d{4}-\d{2}-\d{2}\.png$/);
        });
    });
});
