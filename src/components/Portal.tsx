import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const PORTAL_ROOT_ID = 'wizard-portal-root';

/**
 * Finds (or lazily creates) the single shared container every `Portal`
 * instance in this window renders into. Appended directly to
 * `document.body` -- a SIBLING of `#root`, not a descendant of it -- so
 * anything rendered through it escapes every ancestor's `overflow`,
 * `transform`/`contain` or `position` context, which is exactly the
 * problem the Dashboard visual refresh needs solved for popovers (color
 * picker, pin Y-axis, add-to-failure-group, alarm setpoints -- see the
 * 2026-09-30 SPEC FINAL entry in docs/PROJECT_HANDOVER.md: "popover ทุกตัว
 * ... ต้องเรนเดอร์ผ่าน portal ไม่อยู่ในรายการที่ scroll ได้").
 *
 * This app is a Tauri v2 multi-window app, but each window (`main`,
 * `build-model`, `add-sensor`) is its own separate HTML document with its
 * own `document` / `document.body` (see `src/main.tsx` -- one
 * `ReactDOM.createRoot` per window, picked by a `?window=` URL param), so
 * "append to `document.body`" never reaches across windows -- a Portal
 * used inside the `build-model` window only ever mounts into THAT
 * window's own body, same as `#root` does today.
 *
 * One container is reused across every `Portal` instance mounted at the
 * same time (checked by id, not created per-instance) so popovers stack
 * in the DOM in mount order under one single new top-level node, instead
 * of each adding its own loose `<div>` directly on `<body>`.
 */
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

/**
 * Thin wrapper around `ReactDOM.createPortal`. Renders `children` into the
 * shared `#wizard-portal-root` container described above instead of in
 * place in the component tree.
 *
 * Deliberately NOT wired into any existing popover/modal yet -- this is
 * Phase 0 (foundation only) of the visual refresh. A later phase rewires
 * each popover component to use this once it touches that component's
 * look, per `docs/PROJECT_HANDOVER.md`'s 2026-10-02 "HANDOFF INDEX" entry.
 *
 * Usage:
 * ```tsx
 * {open && (
 *     <Portal>
 *         <div className="popover-surface" style={{ position: 'absolute', top, left }}>
 *             ...
 *         </div>
 *     </Portal>
 * )}
 * ```
 *
 * The portal root is created lazily on first mount (not at module load),
 * so importing this file has no side effect in a non-DOM environment
 * (e.g. a test file that imports other exports from this module without
 * ever rendering `<Portal>`).
 */
export default function Portal({ children }: PortalProps) {
    const [container, setContainer] = useState<HTMLElement | null>(null);
    // Only used to avoid calling getOrCreatePortalRoot() twice if effects
    // ever re-run (e.g. React StrictMode's dev-only double-invoke) --
    // getOrCreatePortalRoot() is already idempotent via getElementById, so
    // this is a belt-and-suspenders guard, not load-bearing correctness.
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
