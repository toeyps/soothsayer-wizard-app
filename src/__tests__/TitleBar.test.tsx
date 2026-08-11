import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const mockMinimize = vi.fn();
const mockToggleMaximize = vi.fn();
const mockClose = vi.fn();
const mockGetCurrentWindow = vi.fn(() => ({
    minimize: mockMinimize, toggleMaximize: mockToggleMaximize, close: mockClose,
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

let mockIsMacOS = false;
vi.mock('../hooks/useIsMacOS', () => ({
    useIsMacOS: () => mockIsMacOS,
}));

import TitleBar from '../components/TitleBar';

beforeEach(() => {
    mockIsMacOS = false;
    mockMinimize.mockClear();
    mockToggleMaximize.mockClear();
    mockClose.mockClear();
});

afterEach(() => {
    cleanup();
});

describe('TitleBar', () => {
    it('shows no workspace section when workspaceName is undefined', () => {
        render(<TitleBar theme="dark" toggleTheme={vi.fn()} />);
        expect(screen.queryByText('Workspace:')).toBeNull();
    });

    it('shows the workspace name, falling back to "Unnamed Workspace" when empty', () => {
        const { rerender } = render(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" />);
        expect(screen.getByText('My WS')).toBeTruthy();

        rerender(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="" />);
        expect(screen.getByText('Unnamed Workspace')).toBeTruthy();
    });

    describe('inline rename', () => {
        it('clicking the name enters edit mode with an input prefilled with the current name', () => {
            render(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" />);
            fireEvent.click(screen.getByText('My WS'));
            expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('My WS');
        });

        it('blurring with a changed, non-empty name commits via onRename', () => {
            const onRename = vi.fn();
            render(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" onRename={onRename} />);
            fireEvent.click(screen.getByText('My WS'));
            const input = screen.getByRole('textbox');
            fireEvent.change(input, { target: { value: 'New Name' } });
            fireEvent.blur(input);
            expect(onRename).toHaveBeenCalledWith('New Name');
        });

        it('does not call onRename when the name is unchanged or blank', () => {
            const onRename = vi.fn();
            render(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" onRename={onRename} />);
            fireEvent.click(screen.getByText('My WS'));
            fireEvent.blur(screen.getByRole('textbox')); // unchanged
            expect(onRename).not.toHaveBeenCalled();

            fireEvent.click(screen.getByText('My WS'));
            fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
            fireEvent.blur(screen.getByRole('textbox'));
            expect(onRename).not.toHaveBeenCalled();
        });

        it('Enter commits the same as blur', () => {
            const onRename = vi.fn();
            render(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" onRename={onRename} />);
            fireEvent.click(screen.getByText('My WS'));
            const input = screen.getByRole('textbox');
            fireEvent.change(input, { target: { value: 'Enter Name' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onRename).toHaveBeenCalledWith('Enter Name');
        });

        it('Escape cancels the edit and reverts the draft without committing', () => {
            const onRename = vi.fn();
            render(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" onRename={onRename} />);
            fireEvent.click(screen.getByText('My WS'));
            const input = screen.getByRole('textbox');
            fireEvent.change(input, { target: { value: 'Discarded' } });
            fireEvent.keyDown(input, { key: 'Escape' });
            expect(screen.getByText('My WS')).toBeTruthy();
            expect(onRename).not.toHaveBeenCalled();
        });

        it('a renameTrigger bump auto-enters edit mode', () => {
            const { rerender } = render(
                <TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" renameTrigger={0} />,
            );
            expect(screen.queryByRole('textbox')).toBeNull();

            rerender(<TitleBar theme="dark" toggleTheme={vi.fn()} workspaceName="My WS" renameTrigger={1} />);
            expect(screen.getByRole('textbox')).toBeTruthy();
        });
    });

    describe('theme toggle', () => {
        it('shows a Sun icon in dark mode and a Moon icon in light mode', () => {
            const { rerender, container } = render(<TitleBar theme="dark" toggleTheme={vi.fn()} />);
            expect(container.querySelector('.lucide-sun')).toBeTruthy();

            rerender(<TitleBar theme="light" toggleTheme={vi.fn()} />);
            expect(container.querySelector('.lucide-moon')).toBeTruthy();
        });

        it('clicking it calls toggleTheme', () => {
            const toggleTheme = vi.fn();
            render(<TitleBar theme="dark" toggleTheme={toggleTheme} />);
            fireEvent.click(screen.getByTitle('Switch to light mode'));
            expect(toggleTheme).toHaveBeenCalled();
        });
    });

    describe('window controls', () => {
        it('are shown and wired on non-macOS', () => {
            mockIsMacOS = false;
            const { container } = render(<TitleBar theme="dark" toggleTheme={vi.fn()} />);
            const buttons = container.querySelectorAll('.titlebar-button');
            expect(buttons.length).toBe(4); // theme + minimize + maximize + close

            fireEvent.click(container.querySelector('.titlebar-button:nth-child(3)')!); // minimize
            expect(mockMinimize).toHaveBeenCalled();

            fireEvent.click(container.querySelector('.titlebar-button:nth-child(4)')!); // maximize
            expect(mockToggleMaximize).toHaveBeenCalled();

            fireEvent.click(container.querySelector('.titlebar-button.close')!);
            expect(mockClose).toHaveBeenCalled();
        });

        it('are hidden on macOS (native traffic lights used instead)', () => {
            mockIsMacOS = true;
            const { container } = render(<TitleBar theme="dark" toggleTheme={vi.fn()} />);
            const buttons = container.querySelectorAll('.titlebar-button');
            expect(buttons.length).toBe(1); // theme toggle only
        });
    });
});
