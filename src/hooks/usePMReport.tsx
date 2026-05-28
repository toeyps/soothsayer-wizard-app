import { useCallback } from 'react';
import { toPng } from 'html-to-image';
import { pdf } from '@react-pdf/renderer';
import * as echarts from 'echarts';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { PMReportTemplate } from '../components/reports/PMReportTemplate';
import type { PMReportData } from '../components/reports/pmReportTypes';

// ───────── Helpers ─────────

/**
 * Strip the `data:image/png;base64,` prefix from a data URL and decode the
 * remainder into raw bytes — Tauri's `writeFile` expects a Uint8Array.
 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * One captured ECharts chart: where it lives on the page and the PNG we
 * pulled from its `getDataURL()`. Coordinates are in CSS pixels relative
 * to the captured node's top-left.
 */
interface ChartCapture {
    x: number;
    y: number;
    width: number;
    height: number;
    dataUrl: string;
}

/**
 * Walk `node` and ask every ECharts instance for its own PNG via
 * `getDataURL()`. We capture position relative to `node`'s top-left so we
 * can later paint each chart onto the page screenshot in the right spot.
 *
 * Falls back gracefully when an ECharts instance lookup fails — the
 * `console.warn` exposes detection counts so a user reporting "charts
 * still missing" can open devtools and see whether 0 instances were
 * found (module duplication / SVG renderer / late mount) vs N instances
 * (bug elsewhere in the compositing).
 */
/**
 * Re-render a live ECharts instance into an offscreen container at the
 * given size, then snapshot it. The reason we don't just call
 * `liveInstance.getDataURL()` is that getDataURL internally re-renders to
 * a fresh canvas — and with the scatter charts' default
 * `progressive: 5000 / large: true / animation: true` flags, that fresh
 * render only paints axes before getDataURL returns (rest of the points
 * arrive across later frames). Forcing those flags off in the cloned
 * option AND waiting on ECharts' `finished` event guarantees a fully
 * painted snapshot.
 *
 * 2s safety timeout covers edge cases (e.g. empty series) where
 * 'finished' doesn't fire.
 */
async function captureChartSafely(
    liveInstance: ReturnType<typeof echarts.init>,
    width: number,
    height: number,
    backgroundColor: string,
): Promise<string> {
    const offscreen = document.createElement('div');
    offscreen.style.cssText =
        `position:absolute; left:-99999px; top:0; width:${width}px; height:${height}px`;
    document.body.appendChild(offscreen);
    let temp: ReturnType<typeof echarts.init> | null = null;
    try {
        const option = liveInstance.getOption();
        const seriesArr = Array.isArray(option.series) ? option.series : [];
        const safeOption = {
            ...option,
            animation: false,
            series: seriesArr.map((s: any) => ({
                ...s,
                animation: false,
                progressive: 0,
                progressiveThreshold: 0,
                large: false,
            })),
        };
        temp = echarts.init(offscreen);
        temp.setOption(safeOption, { notMerge: true });
        await new Promise<void>(resolve => {
            let done = false;
            const settle = () => { if (done) return; done = true; resolve(); };
            temp!.on('finished', settle);
            setTimeout(settle, 2000);
        });
        return temp.getDataURL({
            type: 'png',
            pixelRatio: 2,
            backgroundColor,
        });
    } finally {
        if (temp) temp.dispose();
        offscreen.remove();
    }
}

async function collectECharts(node: HTMLElement): Promise<ChartCapture[]> {
    const captures: ChartCapture[] = [];
    const allDivs = Array.from(node.querySelectorAll('div')) as HTMLDivElement[];
    const nodeRect = node.getBoundingClientRect();
    let probed = 0;
    for (const container of allDivs) {
        // ECharts attaches the instance to whichever element was passed to
        // `echarts.init()` — for echarts-for-react that's the wrapper div
        // it renders. Non-chart divs return null cheaply.
        const instance = echarts.getInstanceByDom(container);
        if (!instance) continue;
        probed++;
        try {
            const cRect = container.getBoundingClientRect();
            const bg = getComputedStyle(container).backgroundColor || 'transparent';
            const dataUrl = await captureChartSafely(instance, cRect.width, cRect.height, bg);
            captures.push({
                x: cRect.left - nodeRect.left,
                y: cRect.top - nodeRect.top,
                width: cRect.width,
                height: cRect.height,
                dataUrl,
            });
        } catch (e) {
            console.warn('[Report] ECharts capture failed:', e);
        }
    }
    console.warn(`[Report] Probed ${allDivs.length} divs, found ${probed} ECharts instances.`);
    return captures;
}

/** Decode a data URL into a fully-painted Image element. */
function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = src;
    });
}

/**
 * Capture a DOM node as a PNG data URL.
 *
 * Two-pass strategy that avoids the DOM-mutation pitfalls we hit when
 * trying to overlay chart snapshots before html-to-image's clone:
 *
 *   PASS 1 — html-to-image renders the page normally. Chart canvases
 *            inside ECharts come out blank (html-to-image's generic
 *            canvas handling doesn't cope with ECharts' multi-layer
 *            stacking and DOM mutations during clone).
 *   PASS 2 — Manually composite each chart's `getDataURL()` PNG on top
 *            of the page screenshot using Canvas 2D's `drawImage`. The
 *            positions are recorded relative to the captured node so
 *            we paint into the same coordinate space.
 *
 * No DOM mutation other than the overflow expansion (which is needed so
 * the page-screenshot pass sees the full content of scrollable panels).
 * No fighting with z-index, opacity, or container positioning. The chart
 * is painted ON TOP of whatever html-to-image rendered (so even if
 * html-to-image painted some weird thing in the chart area, the chart
 * image covers it cleanly).
 */
async function captureNodeFull(node: HTMLElement, pixelRatio = 2): Promise<string> {
    // ── Step 1: un-clip scrollable descendants so the screenshot includes
    //    everything, not just what's currently in the viewport. ──
    const overflowMutations: Array<{ el: HTMLElement; overflow: string; maxHeight: string }> = [];
    node.querySelectorAll<HTMLElement>('*').forEach(el => {
        const computed = getComputedStyle(el);
        const scrollableY = computed.overflowY === 'auto' || computed.overflowY === 'scroll';
        const scrollableX = computed.overflowX === 'auto' || computed.overflowX === 'scroll';
        const scrollableAll = computed.overflow === 'auto' || computed.overflow === 'scroll';
        if (scrollableY || scrollableX || scrollableAll) {
            overflowMutations.push({ el, overflow: el.style.overflow, maxHeight: el.style.maxHeight });
            el.style.overflow = 'visible';
            el.style.maxHeight = 'none';
        }
    });
    // Give the browser a frame so any layout changes from un-clipping
    // propagate to ECharts (which auto-resizes via ResizeObserver).
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    try {
        // ── Step 2: capture each chart via an offscreen safe re-render
        //    BEFORE html-to-image moves on. Each capture waits on ECharts'
        //    `finished` event so scatter data points are fully painted
        //    (live `getDataURL` with progressive scatter draws axes only).
        //    Coordinates locked to the laid-out page so the compositor in
        //    Step 5 knows where to paint each chart. ──
        const chartCaptures = await collectECharts(node);

        // ── Step 3: page screenshot. Chart areas come out blank/wrong;
        //    that's expected — we'll overpaint them in Step 5. ──
        const pageDataUrl = await toPng(node, {
            pixelRatio,
            cacheBust: true,
            backgroundColor: getComputedStyle(node).backgroundColor || '#0f172a',
        });

        // ── Step 4: short-circuit if there were no charts to composite. ──
        if (chartCaptures.length === 0) return pageDataUrl;

        // ── Step 5: composite. Load the page PNG + every chart PNG into
        //    Image elements, then paint into an offscreen Canvas2D scaled
        //    by pixelRatio (since the page PNG is already 2× CSS size). ──
        const pageImg = await loadImage(pageDataUrl);
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = pageImg.naturalWidth;
        finalCanvas.height = pageImg.naturalHeight;
        const ctx = finalCanvas.getContext('2d');
        if (!ctx) {
            console.warn('[Report] 2D context unavailable — returning page-only PNG.');
            return pageDataUrl;
        }
        ctx.drawImage(pageImg, 0, 0);

        for (const c of chartCaptures) {
            try {
                const chartImg = await loadImage(c.dataUrl);
                ctx.drawImage(
                    chartImg,
                    Math.round(c.x * pixelRatio),
                    Math.round(c.y * pixelRatio),
                    Math.round(c.width * pixelRatio),
                    Math.round(c.height * pixelRatio),
                );
            } catch (e) {
                console.warn('[Report] Failed to composite a chart:', e);
            }
        }

        return finalCanvas.toDataURL('image/png');
    } finally {
        overflowMutations.forEach(({ el, overflow, maxHeight }) => {
            el.style.overflow = overflow;
            el.style.maxHeight = maxHeight;
        });
    }
}

/** "wizard-report-MyWorkspace-2026-05-21" → filesystem-safe stem. */
function buildDefaultName(workspaceName: string, when: Date, ext: string): string {
    const ws = (workspaceName || 'untitled')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')   // keep alnum / dash / underscore
        .replace(/^-+|-+$/g, '')             // trim leading/trailing dashes
        .slice(0, 40) || 'untitled';
    const yyyy = when.getFullYear();
    const mm = String(when.getMonth() + 1).padStart(2, '0');
    const dd = String(when.getDate()).padStart(2, '0');
    return `wizard-report-${ws}-${yyyy}-${mm}-${dd}.${ext}`;
}

// ───────── Hook ─────────

export interface PMReportHook {
    /**
     * Capture the given DOM node as a PNG via html-to-image (plus ECharts
     * `getDataURL()` for chart overlays), prompt for save location, and
     * write to disk. PNG is a "what you see is what you get" screenshot of
     * the live PM page — useful for quick visual sharing.
     */
    exportPNG: (node: HTMLElement, workspaceName: string) => Promise<void>;
    /**
     * Render a structured PDF report from the supplied data object using
     * `<PMReportTemplate />` (react-pdf). The PM page is responsible for
     * assembling the data — this function just renders + saves. Unlike
     * `exportPNG`, this is a designed document (text-selectable, paginated
     * tables, themed headers) NOT a screenshot.
     */
    exportPDF: (data: PMReportData) => Promise<void>;
}

export function usePMReport(): PMReportHook {
    const exportPNG = useCallback(async (node: HTMLElement, workspaceName: string) => {
        const now = new Date();
        const defaultPath = buildDefaultName(workspaceName, now, 'png');
        const filePath = await save({
            defaultPath,
            filters: [{ name: 'PNG Image', extensions: ['png'] }],
        });
        if (!filePath) return;  // user cancelled

        const dataUrl = await captureNodeFull(node, 2);
        await writeFile(filePath, dataUrlToBytes(dataUrl));
    }, []);

    const exportPDF = useCallback(async (data: PMReportData) => {
        const defaultPath = buildDefaultName(data.meta.workspaceName, data.meta.generatedAt, 'pdf');
        const filePath = await save({
            defaultPath,
            filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
        });
        if (!filePath) return;

        // `pdf(<Doc/>)` returns an instance with a `.toBlob()` method that
        // runs the React render → PDF binary pipeline.
        const blob = await pdf(<PMReportTemplate data={data} />).toBlob();
        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(filePath, new Uint8Array(arrayBuffer));
    }, []);

    return { exportPNG, exportPDF };
}
