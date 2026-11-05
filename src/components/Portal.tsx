import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const PORTAL_ROOT_ID = 'wizard-portal-root';

/** Shared container every `Portal` renders into, a sibling of `#root` in `document.body` so popovers escape ancestors' overflow/transform/position. Each window is its own document; one container is reused (found by id). */
function getOrCreatePortalRoot(): HTMLElement {
    let el = document.getElementById(PORTAL_ROOT_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = PORTAL_ROOT_ID;
        document.body.appendChild(el);
    }
    return el;
}

interface PortalProps {
    children: ReactNode;
}

/** Renders `children` into the shared `#wizard-portal-root` via `ReactDOM.createPortal`; the root is created lazily on first mount so importing has no DOM side effect. */
export default function Portal({ children }: PortalProps) {
    const [container, setContainer] = useState<HTMLElement | null>(null);
    // Guard against calling getOrCreatePortalRoot() twice when effects re-run (StrictMode); it is already idempotent.
    const mountedRef = useRef(false);

    useEffect(() => {
        mountedRef.current = true;
        setContainer(getOrCreatePortalRoot());
        return () => {
            mountedRef.current = false;
        };
    }, []);

    if (!container) return null;
    return createPortal(children, container);
}
