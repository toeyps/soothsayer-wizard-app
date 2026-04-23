import { useEffect, useState } from "react";

/**
 * Dynamically detects whether the current OS is macOS.
 * Prefers Tauri's `@tauri-apps/plugin-os` at runtime; falls back to
 * `navigator.userAgentData` / `navigator.platform` / `navigator.userAgent`.
 */
export function useIsMacOS(): boolean {
    const [isMacOS, setIsMacOS] = useState<boolean>(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // Hide specifier from TS/Vite static analysis so the app still
                // compiles when `@tauri-apps/plugin-os` isn't installed.
                const specifier = "@tauri-apps/plugin-os";
                const mod: any = await import(/* @vite-ignore */ specifier);
                const p = typeof mod.platform === "function" ? await mod.platform() : mod.platform;
                if (!cancelled) setIsMacOS(p === "macos" || p === "darwin");
            } catch {
                const ua =
                    (navigator as any).userAgentData?.platform ||
                    navigator.platform ||
                    navigator.userAgent;
                if (!cancelled) setIsMacOS(/mac/i.test(ua));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return isMacOS;
}
