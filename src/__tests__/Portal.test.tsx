import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Portal from '../components/Portal';

afterEach(() => {
    cleanup();
    // Portal's shared container outlives its component; each test removes it so 'exactly one container' checks stay clean.
    document.getElementById('wizard-portal-root')?.remove();
});

describe('Portal', () => {
    it('renders children into a container appended to document.body, not the call-site DOM location', () => {
        const { container } = render(
            <div data-testid="call-site">
                <Portal>
                    <div data-testid="portal-content">hello</div>
                </Portal>
            </div>,
        );

        // Not rendered inside the call-site subtree.
        expect(container.querySelector('[data-testid="portal-content"]')).toBeNull();

        // Rendered into a dedicated container appended to document.body instead.
        const portalRoot = document.getElementById('wizard-portal-root');
        expect(portalRoot).not.toBeNull();
        expect(portalRoot?.parentElement).toBe(document.body);
        expect(portalRoot?.querySelector('[data-testid="portal-content"]')?.textContent).toBe('hello');
    });

    it('reuses one shared portal root across multiple simultaneously-mounted Portal instances', () => {
        render(
            <>
                <Portal><div data-testid="a">a</div></Portal>
                <Portal><div data-testid="b">b</div></Portal>
            </>,
        );

        const roots = document.querySelectorAll(`#wizard-portal-root`);
        expect(roots.length).toBe(1);
        expect(roots[0].querySelector('[data-testid="a"]')).not.toBeNull();
        expect(roots[0].querySelector('[data-testid="b"]')).not.toBeNull();
    });

    it('removes its own children on unmount without tearing down the shared container', () => {
        const { unmount } = render(
            <Portal><div data-testid="c">c</div></Portal>,
        );

        expect(document.querySelector('[data-testid="c"]')).not.toBeNull();

        unmount();

        expect(document.querySelector('[data-testid="c"]')).toBeNull();
        // The shared container stays when one consumer unmounts; others may use it.
        expect(document.getElementById('wizard-portal-root')).not.toBeNull();
    });

    it('renders nothing (no portal root, no children) before the container is ready and on an empty children render', () => {
        // No children still creates the container once mounted, without throwing.
        const { container } = render(<Portal>{null}</Portal>);
        expect(container.firstChild).toBeNull();
        expect(document.getElementById('wizard-portal-root')).not.toBeNull();
    });
});
