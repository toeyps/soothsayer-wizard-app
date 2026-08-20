import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Download, Lasso, Move, RotateCcw, Table2, X, Search, Trash2 } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeUserTextFile } from '../../workspaceManager';
import PairPlotCell, { HoverInfo, Cluster } from './PairPlotCell';
import AxisLabel from './AxisLabel';
import { ChartProps, MAX_PAIR_PLOT_SENSORS } from './ChartTypes';
import { useThemeMode, type ThemeMode } from '../../hooks/useThemeMode';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { formatDateTime } from '../../utils/dateFormat';
import { ACCENT_HEX, CANVAS_BG_HEX, correlationGradientHex, hexToRgba, hexToRgbaCss, rgbaToHex } from './pairPlotColors';
import { pearsonCorrelation } from './pairPlotStats';

type Tool = 'lasso' | 'pan';

/** Max rows rendered in the dialog table at once. Keeps the DOM cheap and
 *  the scroll responsive on huge lassos; the full set is still in memory
 *  and exportable via the in-dialog CSV button. */
const TABLE_PAGE = 500;

/** Width of the row-label column at the very left. */
const HEAD_W = 0;

/** Colour used by every scatter cell — keeps the matrix visually cohesive so
 *  the user reads density / shape rather than chasing per-cell hue. Derived
 *  from the shared ACCENT_HEX (pairPlotColors.ts) so it never drifts from
 *  the diagonal histogram's bar colour again. */
const POINT_COLOR: [number, number, number, number] = hexToRgba(ACCENT_HEX, 0.55);

/** Must match PairPlotCell's AXIS_PAD so the diagonal histogram's frame
 *  has the exact same inset as every scatter cell. */
const CELL_PAD = { left: 36, right: 4, top: 14, bottom: 18 };

/** Default colour palette for newly-spawned clusters. Cycles when the user
 *  brushes more than 8 clusters; per-cluster colour picker can override. */
const CLUSTER_PALETTE: Array<[number, number, number, number]> = [
    [0.99, 0.75, 0.18, 1.0],  // amber
    [0.20, 0.83, 0.60, 1.0],  // emerald
    [0.86, 0.40, 0.97, 1.0],  // fuchsia
    [0.99, 0.45, 0.45, 1.0],  // rose
    [0.40, 0.85, 0.99, 1.0],  // sky
    [0.99, 0.55, 0.27, 1.0],  // orange
    [0.65, 0.85, 0.40, 1.0],  // lime
    [0.78, 0.66, 0.99, 1.0],  // violet
];

/** Compact diagonal histogram — pure SVG so the cell doesn't burn a WebGL
 *  context just to draw 20 bars. Uses the same pixel padding as PairPlotCell
 *  (CELL_PAD) so the bordered frame matches scatter cells exactly. */
function DiagonalHistogram({
    values, sensor, isTopRow, themeMode,
}: {
    values: number[];
    sensor: string;
    /** Only row 0's diagonal prints its name — it doubles as that column's
     *  header. Every other row's diagonal sits at column i (i > 0), which
     *  row 0 already labeled at the top; repeating it there would be noise
     *  the "outer frame only" label scheme deliberately avoids. */
    isTopRow: boolean;
    themeMode: ThemeMode;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [dims, setDims] = useState({ width: 0, height: 0 });

    // Track container pixel size so the SVG renders in pixel coordinates that
    // match PairPlotCell's frame insets exactly.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setDims({ width: el.clientWidth, height: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const bins = 20;
    const { counts } = useMemo(() => {
        const valid = values.filter(v => v != null && !isNaN(v));
        if (valid.length === 0) return { counts: new Array(bins).fill(0) };
        let mn = Infinity, mx = -Infinity;
        for (const v of valid) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn === mx) mx = mn + 1;
        const step = (mx - mn) / bins;
        const c = new Array(bins).fill(0);
        for (const v of valid) {
            let idx = Math.floor((v - mn) / step);
            if (idx >= bins) idx = bins - 1;
            if (idx < 0) idx = 0;
            c[idx]++;
        }
        return { counts: c };
    }, [values]);

    const maxC = Math.max(1, ...counts);
    const innerW = Math.max(0, dims.width - CELL_PAD.left - CELL_PAD.right);
    const innerH = Math.max(0, dims.height - CELL_PAD.top - CELL_PAD.bottom);

    return (
        <div ref={containerRef} className="pair-regl-cell" style={{ background: CANVAS_BG_HEX[themeMode] }}>
            <svg
                width={dims.width}
                height={dims.height}
                style={{ position: 'absolute', top: 0, left: 0 }}
            >
                {isTopRow && (
                    <text
                        x={CELL_PAD.left + innerW / 2}
                        y={11}
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--text-primary)"
                        fontFamily="Inter, system-ui"
                    >
                        {sensor}
                    </text>
                )}
                {/* Horizontal bars: low value at bottom, high at top. Bar
                    length = count / maxCount across the inner plot width. */}
                {counts.map((c, i) => {
                    const y = CELL_PAD.top + (1 - (i + 1) / bins) * innerH;
                    const h = innerH / bins;
                    const w = (c / maxC) * innerW;
                    return (
                        <rect
                            key={i}
                            x={CELL_PAD.left}
                            y={y}
                            width={w}
                            height={Math.max(0, h - 0.5)}
                            fill={ACCENT_HEX}
                            opacity={0.75}
                        />
                    );
                })}
                {/* Cell border — exactly the same inset as PairPlotCell so the
                    matrix reads as a grid of uniform frames. */}
                <rect
                    x={CELL_PAD.left}
                    y={CELL_PAD.top}
                    width={innerW}
                    height={innerH}
                    fill="none"
                    stroke="var(--border-strong, #334155)"
                    strokeWidth="1"
                />
            </svg>
        </div>
    );
}

/** Lower-triangle correlation heatmap cell — mirrors the upper-triangle
 *  scatter cell for the same sensor pair. Computes nothing new: `r` is
 *  derived once for the whole matrix from the same `sensorVals` sample the
 *  diagonal histograms already use. Tinted by sign (indigo accent = positive,
 *  rose = negative) and magnitude (stronger |r| = more saturated fill), so
 *  the strongest relationships in the matrix are visible at a glance before
 *  drilling into any one scatter cell. */
/** Positioning for the two AxisLabel orientations used across this matrix —
 *  `top` labels span the cell's top padding strip (column headers), `left`
 *  labels span the left padding strip, rotated (row headers). Shared here
 *  so every call site stays consistent with CELL_PAD. */
const AXIS_LABEL_STYLE = {
    top: { top: 0, left: CELL_PAD.left, right: CELL_PAD.right, height: CELL_PAD.top },
    left: { top: CELL_PAD.top, bottom: CELL_PAD.bottom, left: 0, width: CELL_PAD.left },
} as const;

function CorrelationCell({
    r, sensorY, sensorYDescription, showYLabel, themeMode,
}: {
    r: number | null;
    sensorY: string;
    sensorYDescription?: string;
    /** True only for the left-most correlation cell in its row (column 0) —
     *  that's the row's shared header, "outer frame only" like every other
     *  cell type. Correlation cells never sit in row 0, so they never carry
     *  a top/column label — row 0 already labeled that column. */
    showYLabel: boolean;
    themeMode: ThemeMode;
}) {
    // Diverging-by-magnitude, not by sign: weak (|r| near 0) reads red,
    // strong (|r| near 1) reads green regardless of direction — a strong
    // negative relationship is exactly as noteworthy as a strong positive
    // one for this app's use case (spotting *any* tight sensor relationship).
    const mag = r == null ? 0 : Math.abs(r);
    const tintHex = correlationGradientHex(mag);
    const tintAlpha = r == null ? 0 : 0.22 + mag * 0.55;
    const textColor = r == null ? 'var(--text-secondary)' : 'var(--text-primary)';

    return (
        <>
            <div className="pair-regl-cell" style={{ background: CANVAS_BG_HEX[themeMode] }}>
                <div
                    style={{
                        position: 'absolute',
                        left: CELL_PAD.left, right: CELL_PAD.right,
                        top: CELL_PAD.top, bottom: CELL_PAD.bottom,
                        background: hexToRgbaCss(tintHex, tintAlpha),
                        border: '1px solid var(--border-strong, #334155)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 500, color: textColor }}>
                        {r == null ? 'n/a' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}`}
                    </span>
                </div>
            </div>
            {/* Sibling of .pair-regl-cell, not nested inside it — .pair-regl-cell
                clips to the tinted square (see App.css), and the hover
                tooltip needs to escape that boundary to show a full
                description without being cut off. */}
            {showYLabel && (
                <AxisLabel tag={sensorY} description={sensorYDescription} rotate style={AXIS_LABEL_STYLE.left} />
            )}
        </>
    );
}

/** Format a tooltip value cleanly. */
function fmt(n: number): string {
    if (!isFinite(n)) return '—';
    if (Math.abs(n) >= 10000 || (Math.abs(n) > 0 && Math.abs(n) < 0.01)) return n.toExponential(2);
    return n.toFixed(4);
}

function PairPlotChart({ data, sensors, headers, sensorMetadata }: ChartProps) {
    const themeMode = useThemeMode();
    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getDescription = useCallback(
        (tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description || undefined,
        [sensorMetaMap],
    );
    /** Ordered list of brushed clusters. Each lasso pushes a new entry; the
     *  user can recolour or delete any cluster from the bottom panel. */
    const [clusters, setClusters] = useState<Cluster[]>([]);
    /** Counter for unique cluster IDs (Date.now would collide if two lassos
     *  fire in the same ms while React batches state updates). */
    const clusterSeqRef = useRef(0);
    const [hover, setHover] = useState<HoverInfo | null>(null);
    /** Active interaction mode, shared by every cell in the matrix (and the
     *  enlarged-view dialog). Lasso still creates clusters; Pan/zoom lets the
     *  user look closer at a dense cloud without accidentally brushing one. */
    const [tool, setTool] = useState<Tool>('lasso');
    /** Increments on every Reset click; each cell watches it and calls
     *  `sc.reset()` once when it changes. Lets the toolbox broadcast a
     *  reset action to every WebGL canvas without holding refs to them all. */
    const [resetTick, setResetTick] = useState(0);
    /** Dialog open state — drives the in-app review modal that replaced
     *  the immediate CSV download. */
    const [tableOpen, setTableOpen] = useState(false);
    /** Cluster IDs currently visible in the View Table dialog. Reset to "all
     *  enabled" every time the dialog opens — see the `openTable` helper. */
    const [tableFilter, setTableFilter] = useState<Set<string>>(new Set());
    /** Inspect-mode toggle. When true every cell shows an overlay that
     *  intercepts clicks → opens the enlarged view dialog. Auto-disabled
     *  after one click so the cursor returns to normal interactions. */
    const [inspectMode, setInspectMode] = useState(false);
    /** When non-null, render the enlarged-view dialog for the picked cell. */
    const [expanded, setExpanded] = useState<
        | { kind: 'diagonal'; sensorY: string }
        | { kind: 'scatter'; sensorY: string; sensorX: string }
        | { kind: 'time'; sensorY: string }
        | null
    >(null);

    const n = sensors.length;

    /** Lasso completed → spawn a new cluster with the next palette colour. */
    const handleLasso = useCallback((rows: number[]) => {
        if (rows.length === 0) return;
        setClusters(prev => {
            const id = `c-${++clusterSeqRef.current}`;
            const color = CLUSTER_PALETTE[prev.length % CLUSTER_PALETTE.length];
            return [...prev, {
                id,
                label: `Cluster ${prev.length + 1}`,
                color,
                rowIndices: new Set(rows),
            }];
        });
    }, []);

    const handleDeleteCluster = useCallback((id: string) => {
        setClusters(cs => cs.filter(c => c.id !== id));
    }, []);

    const handleRecolour = useCallback((id: string, hex: string) => {
        const rgba = hexToRgba(hex);
        setClusters(cs => cs.map(c => c.id === id ? { ...c, color: rgba } : c));
    }, []);

    /** Union of every cluster's rows — used for the View Table dialog +
     *  the bottom panel count. */
    const allClusterRows = useMemo(() => {
        const s = new Set<number>();
        for (const c of clusters) for (const r of c.rowIndices) s.add(r);
        return s;
    }, [clusters]);

    /** Maps each row index to the cluster it belongs to — for the View
     *  Table's per-row colour swatch column. */
    const rowToCluster = useMemo(() => {
        const m = new Map<number, Cluster>();
        for (const c of clusters) for (const r of c.rowIndices) m.set(r, c);
        return m;
    }, [clusters]);

    /** Rows visible in the table after applying the active filter chips.
     *  Sorted ascending so the table reads top→bottom by source position. */
    const tableRows = useMemo(() => {
        const arr: number[] = [];
        for (const r of allClusterRows) {
            const c = rowToCluster.get(r);
            if (c && tableFilter.has(c.id)) arr.push(r);
        }
        return arr.sort((a, b) => a - b);
    }, [allClusterRows, rowToCluster, tableFilter]);

    /** Open the dialog with every cluster's filter enabled. Toggling chips
     *  from there narrows the view; closing + reopening resets to "all on". */
    const openTable = useCallback(() => {
        setTableFilter(new Set(clusters.map(c => c.id)));
        setTableOpen(true);
    }, [clusters]);

    const toggleClusterFilter = useCallback((id: string) => {
        setTableFilter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    /** Reset every cell's camera back to the full data extent + drop ALL
     *  clusters. Bumping `resetTick` propagates the camera reset to each
     *  PairPlotCell via its own effect. */
    const handleReset = useCallback(() => {
        setResetTick(t => t + 1);
        setClusters([]);
    }, []);

    // Pre-extract each sensor's column once for the diagonal histograms — saves
    // doing it inside the diagonal component each render.
    const sensorVals = useMemo(() => {
        return sensors.map(s => {
            const idx = headers.indexOf(s);
            if (idx < 0) return [];
            return data.map(d => d.values[idx] ?? NaN);
        });
    }, [data, sensors, headers]);

    /** Pearson r for every lower-triangle pair, keyed `"i-k"` (i = row, k =
     *  column, k < i). Computed once per matrix from the same sensorVals
     *  sample — no extra data fetch, just a stat over what's already loaded. */
    const correlations = useMemo(() => {
        const map = new Map<string, number | null>();
        for (let i = 0; i < sensors.length; i++) {
            for (let k = 0; k < i; k++) {
                map.set(`${i}-${k}`, pearsonCorrelation(sensorVals[i], sensorVals[k]));
            }
        }
        return map;
    }, [sensorVals, sensors.length]);

    const handleExportCsv = useCallback(async () => {
        // Export reflects the dialog's current filter — what you see is what
        // you get. Enable every chip first if you want the full set.
        if (tableRows.length === 0) return;

        // Native save dialog: user picks destination + filename. Cancelling
        // returns null → bail without writing.
        let filePath: string | null = null;
        try {
            filePath = await save({
                filters: [{ name: 'CSV Files', extensions: ['csv'] }],
                defaultPath: `pair-plot-clusters-${new Date().toISOString().slice(0, 10)}.csv`,
            });
        } catch (err) {
            console.error('Save dialog failed:', err);
            return;
        }
        if (!filePath) return;

        const cols = ['cluster', 'rowIndex', 'timestamp', ...sensors];
        const escape = (v: string) => /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        const lines = [cols.map(escape).join(',')];
        for (const r of tableRows) {
            const row = data[r];
            if (!row) continue;
            const cluster = rowToCluster.get(r);
            lines.push([
                cluster?.label ?? '',
                String(r),
                row.timestamp ?? '',
                ...sensors.map(s => {
                    const idx = headers.indexOf(s);
                    return idx >= 0 && row.values[idx] != null ? String(row.values[idx]) : '';
                }),
            ].map(escape).join(','));
        }

        try {
            await writeUserTextFile(filePath, lines.join('\n'));
        } catch (err) {
            console.error('CSV write failed:', err);
        }
    }, [tableRows, rowToCluster, data, sensors, headers]);

    if (n < 2) {
        return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
    }
    // Defense-in-depth: Dashboard's tab-enabling logic already keeps the
    // selection at MAX_PAIR_PLOT_SENSORS while in Pair Plot mode, but its
    // bounce-back effect runs AFTER render — this guard covers the one frame
    // where a selection could still exceed the cap (e.g. a workspace restore
    // that persisted a larger selection alongside chartType: 'pair').
    if (n > MAX_PAIR_PLOT_SENSORS) {
        return (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20%' }}>
                Pair Plot supports at most {MAX_PAIR_PLOT_SENSORS} sensors at once — {n} selected
            </div>
        );
    }

    // Grid template: n+1 columns (n sensors + 1 timeseries column) × n rows.
    const gridTemplate = {
        gridTemplateColumns: `repeat(${n + 1}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${n}, minmax(0, 1fr))`,
    };

    return (
        <div className="pair-regl-wrap">
            {/* Global toolbox — Lasso / Pan-zoom are mutually exclusive, shared
                by every cell in the matrix (and the enlarged-view dialog). */}
            <div className="pair-regl-toolbox">
                <button
                    onClick={() => setTool('lasso')}
                    className={`scatter-regl-tool${tool === 'lasso' ? ' active' : ''}`}
                    title="Lasso select — drag to draw a polygon, rows inside light up across every cell"
                    aria-pressed={tool === 'lasso'}
                >
                    <Lasso size={13} />
                </button>
                <button
                    onClick={() => setTool('pan')}
                    className={`scatter-regl-tool${tool === 'pan' ? ' active' : ''}`}
                    title="Pan / zoom — drag to pan, scroll to zoom, without brushing a cluster"
                    aria-pressed={tool === 'pan'}
                >
                    <Move size={13} />
                </button>
                <button
                    onClick={() => setInspectMode(m => !m)}
                    className={`scatter-regl-tool${inspectMode ? ' active' : ''}`}
                    title="Magnifier — click a cell to open an enlarged view"
                    aria-pressed={inspectMode}
                >
                    <Search size={13} />
                </button>
                <button
                    onClick={handleReset}
                    className="scatter-regl-tool"
                    title="Reset view + clear selection"
                >
                    <RotateCcw size={13} />
                </button>
            </div>

            <div className="pair-regl-grid" style={gridTemplate}>
                {Array.from({ length: n }, (_, i) => {
                    const sensorY = sensors[i];
                    const rowCells: React.ReactNode[] = [];

                    for (let k = 0; k < n; k++) {
                        const gridStyle = { gridRow: i + 1, gridColumn: k + 1 };
                        if (k === i) {
                            rowCells.push(
                                <div key={`d-${i}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <DiagonalHistogram
                                        values={sensorVals[i]}
                                        sensor={sensorY}
                                        isTopRow={false}
                                        themeMode={themeMode}
                                    />
                                    {i === 0 && (
                                        <AxisLabel tag={sensorY} description={getDescription(sensorY)} style={AXIS_LABEL_STYLE.top} />
                                    )}
                                    {inspectMode && (
                                        <div
                                            className="pair-regl-inspect-overlay"
                                            onClick={() => {
                                                setExpanded({ kind: 'diagonal', sensorY });
                                                setInspectMode(false);
                                            }}
                                        />
                                    )}
                                </div>
                            );
                        } else if (k > i) {
                            const sensorX = sensors[k];
                            rowCells.push(
                                <div key={`s-${i}-${k}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <PairPlotCell
                                        data={data}
                                        headers={headers}
                                        sensorX={sensorX}
                                        sensorY={sensorY}
                                        showXAxis={i === n - 1}
                                        showYAxis={false}
                                        showXLabel={false}
                                        showYLabel={false}
                                        tool={tool}
                                        clusters={clusters}
                                        onLasso={handleLasso}
                                        onHover={setHover}
                                        pointColor={POINT_COLOR}
                                        resetTick={resetTick}
                                        themeMode={themeMode}
                                    />
                                    {i === 0 && (
                                        <AxisLabel tag={sensorX} description={getDescription(sensorX)} style={AXIS_LABEL_STYLE.top} />
                                    )}
                                    {inspectMode && (
                                        <div
                                            className="pair-regl-inspect-overlay"
                                            onClick={() => {
                                                setExpanded({ kind: 'scatter', sensorY, sensorX });
                                                setInspectMode(false);
                                            }}
                                        />
                                    )}
                                </div>
                            );
                        } else {
                            // Lower triangle (k < i): correlation heatmap for the
                            // same sensor pair as the scatter cell mirrored above
                            // it — no new data fetch, just a stat over sensorVals.
                            rowCells.push(
                                <div key={`c-${i}-${k}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <CorrelationCell
                                        r={correlations.get(`${i}-${k}`) ?? null}
                                        sensorY={sensorY}
                                        sensorYDescription={getDescription(sensorY)}
                                        showYLabel={k === 0}
                                        themeMode={themeMode}
                                    />
                                </div>
                            );
                        }
                    }

                    // Right-most timeseries cell for this row
                    rowCells.push(
                        <div
                            key={`t-${i}`}
                            className="pair-regl-cell-slot"
                            style={{ gridRow: i + 1, gridColumn: n + 1 }}
                        >
                            <PairPlotCell
                                data={data}
                                headers={headers}
                                sensorY={sensorY}
                                isTimeAxis
                                showXAxis={i === n - 1}
                                showYAxis={false}
                                showXLabel={false}
                                showYLabel={false}
                                tool={tool}
                                clusters={clusters}
                                onLasso={handleLasso}
                                onHover={setHover}
                                pointColor={POINT_COLOR}
                                resetTick={resetTick}
                                themeMode={themeMode}
                            />
                            {i === 0 && (
                                <AxisLabel tag="Time" style={AXIS_LABEL_STYLE.top} />
                            )}
                            {inspectMode && (
                                <div
                                    className="pair-regl-inspect-overlay"
                                    onClick={() => {
                                        setExpanded({ kind: 'time', sensorY });
                                        setInspectMode(false);
                                    }}
                                />
                            )}
                        </div>
                    );

                    return rowCells;
                })}
            </div>

            {/* Global hover tooltip — child cells report page-anchored coords
                via `onHover`, so we can position it without re-computing
                offsets inside each cell on every camera move. This same
                tooltip also serves the enlarged-view dialog's PairPlotCell
                (shared `onHover={setHover}`), so its z-index must clear
                .pair-regl-expand-backdrop's 150 or it renders correctly but
                paints behind the modal. */}
            {hover && (
                <div
                    className="scatter-regl-tooltip"
                    style={{
                        position: 'fixed',
                        left: hover.pageX + 14,
                        top: hover.pageY + 14,
                        zIndex: 200,
                    }}
                >
                    <div className="scatter-regl-tooltip-row">
                        <span className="scatter-regl-tooltip-label">{hover.sensorX}</span>
                        <span className="scatter-regl-tooltip-value">
                            {hover.isTimeAxis ? formatDateTime(new Date(hover.xVal)) : fmt(hover.xVal)}
                        </span>
                    </div>
                    <div className="scatter-regl-tooltip-row">
                        <span className="scatter-regl-tooltip-label">{hover.sensorY}</span>
                        <span className="scatter-regl-tooltip-value">{fmt(hover.yVal)}</span>
                    </div>
                    {hover.timestamp && !hover.isTimeAxis && (
                        <div className="scatter-regl-tooltip-ts">{hover.timestamp}</div>
                    )}
                </div>
            )}

            {/* Cluster list — shown once at least one lasso has run. Each
                row is a colour swatch (clickable colour picker) + label +
                point count + delete. Header summarises totals and exposes
                View Table + Reset for bulk actions. */}
            {clusters.length > 0 && (
                <div className="pair-regl-cluster-panel" style={{ left: HEAD_W + 10 }}>
                    <div className="pair-regl-cluster-panel-head">
                        <span>
                            <b>{clusters.length}</b> cluster{clusters.length === 1 ? '' : 's'}
                            <span className="pair-regl-cluster-sep"> · </span>
                            <b>{allClusterRows.size.toLocaleString()}</b> rows
                        </span>
                        <div className="scatter-regl-actions">
                            <button
                                onClick={openTable}
                                className="scatter-regl-btn"
                                title="View brushed rows in a table"
                            >
                                <Table2 size={12} /> View Table
                            </button>
                            <button
                                onClick={handleReset}
                                className="scatter-regl-btn scatter-regl-btn-icon"
                                title="Reset view + drop all clusters"
                            >
                                <RotateCcw size={12} />
                            </button>
                        </div>
                    </div>
                    <ul className="pair-regl-cluster-list">
                        {clusters.map(c => (
                            <li key={c.id} className="pair-regl-cluster-row">
                                <label className="pair-regl-cluster-swatch" style={{ background: rgbaToHex(c.color) }}>
                                    <input
                                        type="color"
                                        value={rgbaToHex(c.color)}
                                        onChange={e => handleRecolour(c.id, e.target.value)}
                                        aria-label={`Change colour of ${c.label}`}
                                    />
                                </label>
                                <span className="pair-regl-cluster-label">{c.label}</span>
                                <span className="pair-regl-cluster-count">
                                    {c.rowIndices.size.toLocaleString()} rows
                                </span>
                                <button
                                    onClick={() => handleDeleteCluster(c.id)}
                                    className="scatter-regl-btn scatter-regl-btn-icon"
                                    title={`Delete ${c.label}`}
                                >
                                    <Trash2 size={11} />
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Enlarged view dialog — opens when the magnifier picks a cell.
                Reuses the same components (PairPlotCell / DiagonalHistogram)
                at full dialog size + a mini toolbox (no magnifier here so
                we don't nest inspections). Selection state flows back to
                the parent so any lasso in here also lights up the matrix
                behind the modal. */}
            {expanded && (
                <div className="pair-regl-expand-backdrop" onClick={() => setExpanded(null)}>
                    <div className="pair-regl-expand-modal" onClick={e => e.stopPropagation()}>
                        <div className="pair-regl-expand-header">
                            <div className="pair-regl-expand-title">
                                {expanded.kind === 'diagonal' && `${expanded.sensorY} — distribution`}
                                {expanded.kind === 'scatter' && `${expanded.sensorX} × ${expanded.sensorY}`}
                                {expanded.kind === 'time' && `${expanded.sensorY} × Time`}
                            </div>
                            <div className="pair-regl-expand-toolbox">
                                {expanded.kind !== 'diagonal' && (
                                    <>
                                        <button
                                            onClick={() => setTool('lasso')}
                                            className={`scatter-regl-tool${tool === 'lasso' ? ' active' : ''}`}
                                            title="Lasso select"
                                            aria-pressed={tool === 'lasso'}
                                        >
                                            <Lasso size={13} />
                                        </button>
                                        <button
                                            onClick={() => setTool('pan')}
                                            className={`scatter-regl-tool${tool === 'pan' ? ' active' : ''}`}
                                            title="Pan / zoom"
                                            aria-pressed={tool === 'pan'}
                                        >
                                            <Move size={13} />
                                        </button>
                                    </>
                                )}
                                <button
                                    onClick={openTable}
                                    className="scatter-regl-tool"
                                    title="View brushed rows"
                                    disabled={allClusterRows.size === 0}
                                >
                                    <Table2 size={13} />
                                </button>
                                <button
                                    onClick={handleReset}
                                    className="scatter-regl-tool"
                                    title="Reset view + drop all clusters"
                                >
                                    <RotateCcw size={13} />
                                </button>
                                <button
                                    onClick={() => setExpanded(null)}
                                    className="scatter-regl-tool"
                                    title="Close"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                        <div className="pair-regl-expand-body">
                            {expanded.kind === 'diagonal' ? (
                                <DiagonalHistogram
                                    values={sensorVals[sensors.indexOf(expanded.sensorY)] ?? []}
                                    sensor={expanded.sensorY}
                                    isTopRow={true}
                                    themeMode={themeMode}
                                />
                            ) : (
                                <PairPlotCell
                                    data={data}
                                    headers={headers}
                                    sensorY={expanded.sensorY}
                                    sensorX={expanded.kind === 'scatter' ? expanded.sensorX : undefined}
                                    isTimeAxis={expanded.kind === 'time'}
                                    showXAxis
                                    showYAxis
                                    showXLabel
                                    showYLabel
                                    tool={tool}
                                    clusters={clusters}
                                    onLasso={handleLasso}
                                    onHover={setHover}
                                    pointColor={POINT_COLOR}
                                    resetTick={resetTick}
                                    themeMode={themeMode}
                                />
                            )}
                        </div>
                        <div className="pair-regl-expand-footer">
                            {allClusterRows.size > 0
                                ? <span><b>{clusters.length}</b> cluster{clusters.length === 1 ? '' : 's'} · <b>{allClusterRows.size.toLocaleString()}</b> rows — synced with the matrix behind</span>
                                : <span>Drag to lasso · scroll to zoom · each lasso creates a new cluster</span>}
                        </div>
                    </div>
                </div>
            )}

            {/* Modal dialog — table view of the currently-selected rows.
                Click the backdrop or the X button to dismiss. CSV export
                survives as a secondary action inside the dialog header. */}
            {tableOpen && allClusterRows.size > 0 && (
                <div className="pair-regl-modal-backdrop" onClick={() => setTableOpen(false)}>
                    <div className="pair-regl-modal" onClick={e => e.stopPropagation()}>
                        <div className="pair-regl-modal-header">
                            <div className="pair-regl-modal-title">
                                Brushed rows
                                <span className="pair-regl-modal-count">
                                    {tableRows.length.toLocaleString()}
                                    {tableRows.length !== allClusterRows.size && (
                                        <span style={{ opacity: 0.7, marginLeft: 4 }}>
                                            / {allClusterRows.size.toLocaleString()}
                                        </span>
                                    )}
                                </span>
                            </div>
                            <div className="pair-regl-modal-actions">
                                <button onClick={handleExportCsv} className="scatter-regl-btn" title="Download visible rows as CSV" disabled={tableRows.length === 0}>
                                    <Download size={12} /> CSV
                                </button>
                                <button
                                    onClick={() => setTableOpen(false)}
                                    className="scatter-regl-btn scatter-regl-btn-icon"
                                    title="Close"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                        {/* Cluster filter chip bar — click a chip to toggle that
                            cluster's rows in/out of the visible set + CSV export. */}
                        <div className="pair-regl-modal-filter">
                            <span className="pair-regl-modal-filter-label">Filter:</span>
                            {clusters.map(c => {
                                const active = tableFilter.has(c.id);
                                return (
                                    <button
                                        key={c.id}
                                        type="button"
                                        onClick={() => toggleClusterFilter(c.id)}
                                        className={`pair-regl-filter-chip${active ? ' active' : ''}`}
                                        aria-pressed={active}
                                        title={active ? `Hide ${c.label}` : `Show ${c.label}`}
                                    >
                                        <span
                                            className="pair-regl-filter-chip-dot"
                                            style={{ background: rgbaToHex(c.color) }}
                                        />
                                        {c.label}
                                        <span className="pair-regl-filter-chip-count">
                                            {c.rowIndices.size.toLocaleString()}
                                        </span>
                                    </button>
                                );
                            })}
                            <div className="pair-regl-modal-filter-spacer" />
                            <button
                                type="button"
                                onClick={() => setTableFilter(new Set(clusters.map(c => c.id)))}
                                className="pair-regl-filter-mini"
                                title="Enable every cluster"
                                disabled={tableFilter.size === clusters.length}
                            >
                                All
                            </button>
                            <button
                                type="button"
                                onClick={() => setTableFilter(new Set())}
                                className="pair-regl-filter-mini"
                                title="Disable every cluster"
                                disabled={tableFilter.size === 0}
                            >
                                None
                            </button>
                        </div>
                        <div className="pair-regl-modal-body">
                            <table className="pair-regl-modal-table">
                                <thead>
                                    <tr>
                                        <th>Cluster</th>
                                        <th>#</th>
                                        <th>Timestamp</th>
                                        {sensors.map(s => <th key={s}>{s}</th>)}
                                    </tr>
                                </thead>
                                <tbody>
                                    {tableRows.slice(0, TABLE_PAGE).map(r => {
                                        const row = data[r];
                                        if (!row) return null;
                                        const cluster = rowToCluster.get(r);
                                        return (
                                            <tr key={r}>
                                                <td>
                                                    {cluster && (
                                                        <span className="pair-regl-cluster-chip">
                                                            <span
                                                                className="pair-regl-cluster-chip-dot"
                                                                style={{ background: rgbaToHex(cluster.color) }}
                                                            />
                                                            {cluster.label}
                                                        </span>
                                                    )}
                                                </td>
                                                <td>{r}</td>
                                                <td>{row.timestamp || ''}</td>
                                                {sensors.map(s => {
                                                    const idx = headers.indexOf(s);
                                                    const v = idx >= 0 ? row.values[idx] : null;
                                                    return (
                                                        <td key={s}>
                                                            {v != null ? Number(v).toFixed(4) : '—'}
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                            {tableRows.length > TABLE_PAGE && (
                                <div className="pair-regl-modal-more">
                                    Showing first {TABLE_PAGE.toLocaleString()} of {tableRows.length.toLocaleString()} rows — use CSV to export all
                                </div>
                            )}
                            {tableRows.length === 0 && (
                                <div className="pair-regl-modal-more">
                                    No rows visible — enable at least one cluster chip above.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default memo(PairPlotChart);
