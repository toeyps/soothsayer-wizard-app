/**
 * react-pdf template for the Predictive Model Build report.
 *
 * Layout:
 *   • PAGE 1 — landscape A4 body containing Overview / Predictors /
 *     Filters / Model Configuration. Section spacing is tuned tight so
 *     all four sections fit on one page for typical workloads (Model
 *     Config in particular must not overflow — that was the explicit
 *     ask). For very long predictor or filter tables react-pdf still
 *     auto-paginates.
 *   • PAGE 2+ — one landscape page per captured ECharts chart so the
 *     1600×900 PNG snapshot has room to render axis labels and points
 *     at readable size.
 *
 * Design contract:
 *   • The template is PURE — it reads ONLY from `PMReportData`. The PM
 *     page is solely responsible for assembling the data; this component
 *     is oblivious to React state, ECharts, etc.
 *   • Section bodies are small components so re-ordering, adding, or
 *     styling a section touches one local component.
 *   • Tables are hand-rolled <View>s with flexDirection:row — react-pdf
 *     doesn't support `gap` or `display: grid`.
 *
 * Adding a section:
 *   1. Add fields to PMReportData (in pmReportTypes.ts) if needed.
 *   2. Write a `const NewSection = ({ data }) => (...)` below.
 *   3. Render it inside the body Page in the order you want.
 *   4. Bump the section number prop so the badges stay in sequence.
 *
 * Caveats:
 *   • Fonts: only Helvetica / Times / Courier ship bundled.
 *   • `position: absolute` works inside <Page>; we use it for the fixed
 *     footer band and the left rail.
 *   • <View> defaults to flexDirection: 'column'.
 */

import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import type { PMReportData, ReportSensorRef, ReportSensorStats } from './pmReportTypes';
import { stiffnessLabel } from './pmReportTypes';
import type { WorkspaceSensorFilter } from '../../types';
import { REPORT_THEME as T } from './pmReportTheme';
import { formatDateTime } from '../../utils/dateFormat';

// ─────────────────────────── Helpers ───────────────────────────

const fmtNum = (n: number | null | undefined, digits = 3): string => {
    if (n == null || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1e6 || (Math.abs(n) > 0 && Math.abs(n) < 1e-3)) {
        return n.toExponential(2);
    }
    return n.toFixed(digits);
};

const fmtInt = (n: number | null | undefined): string => {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
};

const fmtDate = formatDateTime;

const fmtFilter = (f: WorkspaceSensorFilter): string => {
    switch (f.operation) {
        case 'less_than':    return `< ${f.value1}`;
        case 'greater_than': return `> ${f.value1}`;
        case 'between':      return `${f.value1} … ${f.value2}`;
        case 'equals':       return `= ${f.value1}`;
        default:             return '—';
    }
};

const modeLabel = (m: PMReportData['mode']): string =>
    m === 'relationship' ? 'Relationship'
        : m === 'clustering' ? 'Clustering' : 'Not selected';

// Section titles in render order — used by the footer indicator.
const SECTIONS = [
    'Overview',
    'Predictor Sensors',
    'Data Filters',
    'Model Configuration',
    'Preview Charts',
] as const;

// ─────────────────────────── Styles ───────────────────────────

const styles = StyleSheet.create({
    // ── BODY PAGE (landscape) ──
    bodyPage: {
        fontFamily: 'Helvetica',
        fontSize: T.font.body,
        color: T.colors.text,
        backgroundColor: T.colors.white,
        // Extra left padding clears the navy rail.
        paddingLeft: T.spacing.page + 8,
        paddingRight: T.spacing.page,
        paddingTop: T.spacing.page,
        paddingBottom: T.bands.footerHeight + T.spacing.section,
        position: 'relative',
    },
    // Slim navy bar down the left edge of every body page.
    bodyRail: {
        position: 'absolute',
        left: 0, top: 0, bottom: 0,
        width: 5,
        backgroundColor: T.colors.navy,
    },

    // Footer band — repeats on every body page.
    footerBand: {
        position: 'absolute',
        bottom: 0, left: 0, right: 0,
        height: T.bands.footerHeight,
        backgroundColor: T.colors.navy,
        paddingHorizontal: T.spacing.bandX,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    footerText: {
        fontSize: T.font.footer,
        color: T.colors.textFaint,
    },
    footerTextBold: {
        fontSize: T.font.footer,
        color: T.colors.white,
        fontFamily: 'Helvetica-Bold',
    },

    // Section header — numbered badge + title + accent rule. Tightened
    // vertical spacing (compared to v1) so four sections fit one page.
    sectionWrap: { marginBottom: 12 },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 6,
    },
    sectionBadge: {
        width: T.bands.sectionBadgeW,
        height: T.bands.sectionBadgeH,
        backgroundColor: T.colors.navy,
        borderRadius: 4,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
    },
    sectionBadgeText: {
        color: T.colors.white,
        fontFamily: 'Helvetica-Bold',
        fontSize: T.font.sectionNum,
    },
    sectionTitleBlock: {
        flex: 1,
        flexDirection: 'column',
    },
    sectionTitle: {
        fontSize: T.font.sectionTitle,
        fontFamily: 'Helvetica-Bold',
        color: T.colors.text,
    },
    sectionSubtitle: {
        marginTop: 1,
        fontSize: T.font.sectionSub,
        color: T.colors.textMuted,
    },
    sectionRule: {
        height: 1.5,
        backgroundColor: T.colors.accent,
        marginBottom: 8,
    },

    // ── Overview lead row (compact target + mode) ──
    // Replaces the two big info cards from v1: just one horizontal line
    // with tag (bold) · description (muted) on the left and a small mode
    // pill on the right. Costs ~14pt of vertical space instead of ~85pt.
    overviewLead: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
        paddingBottom: 6,
        borderBottomWidth: 0.5,
        borderBottomColor: T.colors.borderSoft,
    },
    overviewLeadLeft: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'baseline',
        flexWrap: 'wrap',
    },
    overviewLeadTag: {
        fontSize: T.font.body + 1,
        color: T.colors.text,
        fontFamily: 'Helvetica-Bold',
        marginRight: 8,
    },
    overviewLeadDesc: {
        fontSize: T.font.bodySmall,
        color: T.colors.textMuted,
    },
    // Small accent-filled pill showing the selected mode.
    modePill: {
        marginLeft: 8,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 9,
        backgroundColor: T.colors.accentSoft,
        color: T.colors.navy,
        fontSize: T.font.bodySmall,
        fontFamily: 'Helvetica-Bold',
    },
    modePillMuted: {
        backgroundColor: T.colors.borderSoft,
        color: T.colors.textMuted,
    },

    // Key/value pair grid (used inside sections)
    kvGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    kvCell: {
        // Two-column layout: each cell takes 50% minus a gutter
        width: '50%',
        flexDirection: 'row',
        paddingVertical: 2.5,
        paddingRight: 12,
    },
    kvLabel: {
        width: 110,
        fontSize: T.font.body,
        color: T.colors.textMuted,
    },
    kvValue: {
        flex: 1,
        fontSize: T.font.body,
        color: T.colors.text,
        fontFamily: 'Helvetica-Bold',
    },

    // Table primitive
    table: {
        borderWidth: 0.6,
        borderColor: T.colors.border,
        borderRadius: 4,
    },
    tableHeader: {
        flexDirection: 'row',
        backgroundColor: T.colors.navy,
    },
    tableRow: {
        flexDirection: 'row',
        borderTopWidth: 0.4,
        borderTopColor: T.colors.borderSoft,
    },
    tableRowAlt: { backgroundColor: T.colors.rowAlt },
    th: {
        paddingHorizontal: T.spacing.cellX,
        paddingVertical: T.spacing.cellY,
        fontSize: T.font.label,
        color: T.colors.white,
        fontFamily: 'Helvetica-Bold',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    td: {
        paddingHorizontal: T.spacing.cellX,
        paddingVertical: T.spacing.cellY,
        fontSize: T.font.bodySmall,
        color: T.colors.text,
    },
    tdMuted: { color: T.colors.textMuted },
    tdTag: { color: T.colors.navy, fontFamily: 'Helvetica-Bold' },

    // Empty-state placeholder
    empty: {
        fontSize: T.font.bodySmall,
        color: T.colors.textFaint,
        fontStyle: 'italic',
        paddingVertical: 6,
        paddingHorizontal: 10,
        backgroundColor: T.colors.paper,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: T.colors.borderSoft,
        borderStyle: 'dashed',
    },

    // Chart image — fills body area on its own page
    chartImage: {
        objectFit: 'contain',
        width: '100%',
        maxHeight: 460,
    },
    chartCaption: {
        marginTop: 8,
        textAlign: 'center',
        fontSize: T.font.bodySmall,
        color: T.colors.textMuted,
        fontStyle: 'italic',
    },
});

// ─────────────────────────── Reusable bits ───────────────────────────

const SectionHeader = ({
    number, title, subtitle,
}: { number: number; title: string; subtitle?: string }) => (
    <View>
        <View style={styles.sectionHeader}>
            <View style={styles.sectionBadge}>
                <Text style={styles.sectionBadgeText}>
                    {String(number).padStart(2, '0')}
                </Text>
            </View>
            <View style={styles.sectionTitleBlock}>
                <Text style={styles.sectionTitle}>{title}</Text>
                {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
            </View>
        </View>
        <View style={styles.sectionRule} />
    </View>
);

const KV = ({ label, value }: { label: string; value: string }) => (
    <View style={styles.kvCell}>
        <Text style={styles.kvLabel}>{label}</Text>
        <Text style={styles.kvValue}>{value}</Text>
    </View>
);

const Empty = ({ children }: { children: string }) => (
    <Text style={styles.empty}>{children}</Text>
);

const FooterBand = ({
    workspaceName, sectionLabel, generatedAt,
}: { workspaceName: string; sectionLabel?: string; generatedAt: Date }) => (
    <View style={styles.footerBand} fixed>
        <Text style={styles.footerText}>
            <Text style={styles.footerTextBold}>Wizard</Text>
            {workspaceName ? `  ·  ${workspaceName}` : ''}
            {`  ·  ${fmtDate(generatedAt)}`}
        </Text>
        {sectionLabel ? (
            <Text style={styles.footerText}>{sectionLabel}</Text>
        ) : null}
        <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
    </View>
);

const LeftRail = () => <View style={styles.bodyRail} fixed />;

// ─────────────────────────── Section components ───────────────────────────

const OverviewSection = ({ data }: { data: PMReportData }) => {
    const hasMode = data.mode !== null;
    return (
        <View style={styles.sectionWrap}>
            <SectionHeader number={1} title="Overview" />
            {/* Compact lead — replaces the v1 dual info cards. One line:
                  bold tag · muted description · small mode pill on the right.
                Saves ~70pt of vertical space, which is exactly what Model
                Config needs further down the page. */}
            <View style={styles.overviewLead}>
                <View style={styles.overviewLeadLeft}>
                    <Text style={styles.overviewLeadTag}>
                        {data.target.ref.tag || '—'}
                    </Text>
                    {data.target.ref.description ? (
                        <Text style={styles.overviewLeadDesc}>
                            {data.target.ref.description}
                        </Text>
                    ) : null}
                </View>
                <Text style={[styles.modePill, hasMode ? {} : styles.modePillMuted]}>
                    {modeLabel(data.mode)}
                    {data.individualChecked ? ' + Individual' : ''}
                </Text>
            </View>
            <View style={styles.kvGrid}>
                <KV label="Unit"      value={data.target.ref.unit      || '—'} />
                <KV label="Component" value={data.target.ref.component || '—'} />
                <KV label="Mean"      value={data.target.stats ? fmtNum(data.target.stats.mean) : '—'} />
                <KV label="SD"        value={data.target.stats ? fmtNum(data.target.stats.sd)   : '—'} />
                <KV label="Range"     value={data.target.stats
                    ? `${fmtNum(data.target.stats.min)} … ${fmtNum(data.target.stats.max)}`
                    : '—'} />
                <KV label="Samples"   value={data.target.stats ? fmtInt(data.target.stats.count) : '—'} />
            </View>
        </View>
    );
};

const SensorTable = ({
    rows,
}: { rows: Array<{ ref: ReportSensorRef; stats: ReportSensorStats | null }> }) => {
    // Column widths chosen so total = ~100% of body width on landscape A4.
    const cols = {
        idx:   0.4, tag: 1.6, desc: 3.2, comp: 1.4, unit: 1.0,
        mean:  1.2, sd:  1.2, range: 2.2, count: 1.0,
    };
    return (
        <View style={styles.table}>
            <View style={styles.tableHeader} fixed>
                <Text style={[styles.th, { flex: cols.idx,   textAlign: 'right' }]}>#</Text>
                <Text style={[styles.th, { flex: cols.tag }]}>Tag</Text>
                <Text style={[styles.th, { flex: cols.desc }]}>Description</Text>
                <Text style={[styles.th, { flex: cols.comp }]}>Component</Text>
                <Text style={[styles.th, { flex: cols.unit }]}>Unit</Text>
                <Text style={[styles.th, { flex: cols.mean,  textAlign: 'right' }]}>Mean</Text>
                <Text style={[styles.th, { flex: cols.sd,    textAlign: 'right' }]}>SD</Text>
                <Text style={[styles.th, { flex: cols.range, textAlign: 'right' }]}>Range</Text>
                <Text style={[styles.th, { flex: cols.count, textAlign: 'right' }]}>Count</Text>
            </View>
            {rows.map(({ ref: r, stats }, i) => (
                <View
                    key={r.tag + i}
                    style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}
                    wrap={false}
                >
                    <Text style={[styles.td, styles.tdMuted, { flex: cols.idx,   textAlign: 'right' }]}>{i + 1}</Text>
                    <Text style={[styles.td, styles.tdTag,   { flex: cols.tag }]}>{r.tag || '—'}</Text>
                    <Text style={[styles.td,                 { flex: cols.desc }]}>{r.description || '—'}</Text>
                    <Text style={[styles.td, styles.tdMuted, { flex: cols.comp }]}>{r.component || '—'}</Text>
                    <Text style={[styles.td, styles.tdMuted, { flex: cols.unit }]}>{r.unit || '—'}</Text>
                    <Text style={[styles.td, { flex: cols.mean,  textAlign: 'right' }]}>{stats ? fmtNum(stats.mean) : '—'}</Text>
                    <Text style={[styles.td, { flex: cols.sd,    textAlign: 'right' }]}>{stats ? fmtNum(stats.sd) : '—'}</Text>
                    <Text style={[styles.td, { flex: cols.range, textAlign: 'right' }]}>{stats ? `${fmtNum(stats.min)} … ${fmtNum(stats.max)}` : '—'}</Text>
                    <Text style={[styles.td, { flex: cols.count, textAlign: 'right' }]}>{stats ? fmtInt(stats.count) : '—'}</Text>
                </View>
            ))}
        </View>
    );
};

const PredictorsSection = ({ data }: { data: PMReportData }) => (
    <View style={styles.sectionWrap}>
        <SectionHeader
            number={2}
            title="Predictor Sensors"
            subtitle={`${data.predictors.length} sensor${data.predictors.length === 1 ? '' : 's'} selected as model inputs.`}
        />
        {data.predictors.length === 0
            ? <Empty>No predictors selected.</Empty>
            : <SensorTable rows={data.predictors} />
        }
    </View>
);

const FiltersSection = ({ data }: { data: PMReportData }) => {
    const f = data.filters;
    const allFilters = [
        ...f.dashboardFilters.map(x => ({ ...x, _origin: 'Dashboard' })),
        ...f.pmFilters.map(x => ({ ...x, _origin: 'PM page' })),
    ];
    const hasTime = !!(f.timeStart || f.timeEnd);
    return (
        <View style={styles.sectionWrap}>
            <SectionHeader
                number={3}
                title="Data Filters"
                subtitle="Rows used during model fitting (AND-combined)."
            />
            <View style={styles.kvGrid}>
                <KV label="Time start" value={f.timeStart || '— unbounded —'} />
                <KV label="Time end"   value={f.timeEnd   || '— unbounded —'} />
            </View>
            {allFilters.length === 0 ? (
                hasTime ? null : <Empty>No per-sensor value filters applied.</Empty>
            ) : (
                <View style={[styles.table, { marginTop: 6 }]}>
                    <View style={styles.tableHeader}>
                        <Text style={[styles.th, { flex: 2 }]}>Sensor</Text>
                        <Text style={[styles.th, { flex: 2 }]}>Condition</Text>
                        <Text style={[styles.th, { flex: 1 }]}>Origin</Text>
                    </View>
                    {allFilters.map((filter, i) => (
                        <View
                            key={filter.id || i}
                            style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}
                            wrap={false}
                        >
                            <Text style={[styles.td, styles.tdTag,   { flex: 2 }]}>{filter.sensor || '—'}</Text>
                            <Text style={[styles.td,                 { flex: 2 }]}>{fmtFilter(filter)}</Text>
                            <Text style={[styles.td, styles.tdMuted, { flex: 1 }]}>{filter._origin}</Text>
                        </View>
                    ))}
                </View>
            )}
        </View>
    );
};

const ModelConfigSection = ({ data }: { data: PMReportData }) => (
    <View style={styles.sectionWrap}>
        <SectionHeader
            number={4}
            title="Model Configuration"
            subtitle={
                data.mode === 'relationship' ? 'Relation model parameters and metrics.'
                    : data.mode === 'clustering' ? 'Clustering (KMeans) parameters and cluster bins.'
                        : 'No mode selected — pick Relationship or Clustering before saving.'
            }
        />
        {data.mode === 'relationship' && data.relationshipConfig ? (
            <View style={styles.kvGrid}>
                <KV label="Model name"  value={data.relationshipConfig.modelName || '—'} />
                <KV label="Stiffness"   value={stiffnessLabel(data.relationshipConfig.stiffness)} />
                <KV label="Scatter X"   value={data.relationshipConfig.scatterXSensor || '—'} />
                <KV label="Individual"  value={data.individualChecked ? 'Yes' : 'No'} />
                <KV label="R²"          value={fmtNum(data.relationshipConfig.r2, 4)} />
                <KV label="RMSE"        value={fmtNum(data.relationshipConfig.rmse, 4)} />
            </View>
        ) : data.mode === 'clustering' && data.clusteringConfig ? (
            <>
                <View style={styles.kvGrid}>
                    <KV label="Model name"      value={data.clusteringConfig.modelName || '—'} />
                    <KV label="Criteria sensor" value={data.clusteringConfig.criteriaSensor || '—'} />
                    <KV label="Cluster count"   value={String(data.clusteringConfig.numClusters)} />
                    <KV label="Individual"      value={data.individualChecked ? 'Yes' : 'No'} />
                </View>
                <View style={[styles.table, { marginTop: 8 }]}>
                    <View style={styles.tableHeader}>
                        <Text style={[styles.th, { flex: 0.5, textAlign: 'right' }]}>#</Text>
                        <Text style={[styles.th, { flex: 2,   textAlign: 'right' }]}>Min</Text>
                        <Text style={[styles.th, { flex: 2,   textAlign: 'right' }]}>Max</Text>
                    </View>
                    {data.clusteringConfig.ranges.map((r, i) => (
                        <View
                            key={i}
                            style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}
                            wrap={false}
                        >
                            <Text style={[styles.td, styles.tdMuted, { flex: 0.5, textAlign: 'right' }]}>{i + 1}</Text>
                            <Text style={[styles.td, { flex: 2, textAlign: 'right' }]}>{r.min == null ? '— unbounded —' : fmtNum(r.min)}</Text>
                            <Text style={[styles.td, { flex: 2, textAlign: 'right' }]}>{r.max == null ? '— unbounded —' : fmtNum(r.max)}</Text>
                        </View>
                    ))}
                </View>
            </>
        ) : (
            <Empty>No model configuration recorded.</Empty>
        )}
    </View>
);

// Each chart gets its own landscape page so the captured ECharts PNG
// (1600×900) renders at readable size.
const ChartPage = ({
    workspaceName, generatedAt, chart, index, total,
}: {
    workspaceName: string;
    generatedAt: Date;
    chart: PMReportData['chartImages'][number];
    index: number;
    total: number;
}) => (
    <Page size="A4" orientation="landscape" style={styles.bodyPage}>
        <LeftRail />
        <View style={styles.sectionWrap}>
            <SectionHeader
                number={5}
                title={`Preview Charts (${index + 1}/${total})`}
                subtitle="Captured at expanded size — matches the in-app Expand view."
            />
            <View wrap={false}>
                <Image src={chart.dataUrl} style={styles.chartImage} />
                <Text style={styles.chartCaption}>{chart.label}</Text>
            </View>
        </View>
        <FooterBand
            workspaceName={workspaceName}
            sectionLabel={SECTIONS[4]}
            generatedAt={generatedAt}
        />
    </Page>
);

// ─────────────────────────── Document ───────────────────────────

export function PMReportTemplate({ data }: { data: PMReportData }) {
    const title = `Wizard — PM Report — ${data.meta.workspaceName || 'Untitled'}`;
    return (
        <Document title={title} author="Wizard" producer="Wizard" creator="Wizard">
            {/* Main details — Overview / Predictors / Filters / Model Config
                packed onto a single landscape page. react-pdf still
                auto-paginates if a single section's content overflows. */}
            <Page size="A4" orientation="landscape" style={styles.bodyPage}>
                <LeftRail />
                <OverviewSection data={data} />
                <PredictorsSection data={data} />
                <FiltersSection data={data} />
                <ModelConfigSection data={data} />
                <FooterBand
                    workspaceName={data.meta.workspaceName}
                    sectionLabel="Details"
                    generatedAt={data.meta.generatedAt}
                />
            </Page>

            {/* One chart per page so the 1600×900 capture has room. */}
            {data.chartImages.map((c, i) => (
                <ChartPage
                    key={i}
                    workspaceName={data.meta.workspaceName}
                    generatedAt={data.meta.generatedAt}
                    chart={c}
                    index={i}
                    total={data.chartImages.length}
                />
            ))}
        </Document>
    );
}
