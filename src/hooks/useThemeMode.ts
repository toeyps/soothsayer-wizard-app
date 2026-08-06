import { useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light';

/** Tracks `document.documentElement`'s `data-theme` attribute (toggled by
 *  the app's theme switch) so WebGL/SVG chart code — which can't read CSS
 *  custom properties directly for canvas-context colors — can recompute its
 *  own palette when the user switches theme. */
export function useThemeMode(): ThemeMode {
    const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
        (document.documentElement.getAttribute('data-theme') as ThemeMode) || 'dark'
    );
    useEffect(() => {
        const obs = new MutationObserver(() => {
            const t = document.documentElement.getAttribute('data-theme');
            setThemeMode(t === 'light' ? 'light' : 'dark');
        });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => obs.disconnect();
    }, []);
    return themeMode;
}
