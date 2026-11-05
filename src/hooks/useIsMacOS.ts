import { useEffect, useState } from "react";

/** Detects macOS: prefers `@tauri-apps/plugin-os`, falls back to `navigator.userAgentData` / `platform` / `userAgent`. */
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
