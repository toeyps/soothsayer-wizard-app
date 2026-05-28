/**
 * Visual constants for the Predictive Model PDF report. Centralised so the
 * template feels like a snapshot of the Wizard UI (same navy + accent blue)
 * and so future tweaks (rebrand, font swap, density change) touch one file.
 *
 * Units in this file:
 *   • Colors are hex / CSS strings — react-pdf accepts them as-is.
 *   • Spacing values are POINTS (1pt = 1/72 inch). react-pdf's default unit
 *     for `style` numeric properties is points.
 *   • Font sizes are also points.
 */
export const REPORT_THEME = {
    /**
     * Wizard UI palette.
     * `navy` is the brand color used for chrome (cover background, headers,
     * footers, section number badges). `accent` is the secondary blue used
     * for rules and highlights. Body region is white paper with muted text.
     */
    colors: {
        // Brand
        navy:        '#0f172a',
        navyLight:   '#1e293b',
        navySoft:    '#334155',
        accent:      '#3b82f6',
        accentSoft:  '#dbeafe',

        // Paper
        white:       '#ffffff',
        paper:       '#fafbfc',

        // Text on paper
        text:        '#0f172a',
        textMuted:   '#475569',
        textFaint:   '#94a3b8',

        // Borders / dividers
        border:      '#cbd5e1',
        borderSoft:  '#e2e8f0',
        rowAlt:      '#f8fafc',

        // Status accents (used in stat tiles)
        positive:    '#16a34a',
        negative:    '#dc2626',
        warning:     '#d97706',
    },

    /**
     * Spacing scale in points. `page` is body padding, `section` is the
     * gap between sections, `item` is for tight in-section spacing.
     * Cover and tile groups have their own scales because they need more
     * breathing room.
     */
    spacing: {
        page: 32,
        section: 16,
        item: 6,
        cellX: 7,
        cellY: 5,
        bandX: 32,
        bandY: 14,
        // Cover-page specific
        coverPad: 56,
        coverGap: 18,
        heroPad: 22,
        heroGap: 14,
        // Card / tile
        tileGap: 8,
        tilePadX: 12,
        tilePadY: 10,
    },

    /**
     * Type scale tuned for a PDF that's read at 100% zoom in most viewers.
     * Cover gets bigger sizes for impact; body stays compact so tables fit.
     */
    font: {
        // Cover
        brand:        9,
        coverTitle:   34,
        coverSubtitle:14,
        coverMeta:    9,
        // Body
        title:        16,
        sectionNum:   11,
        sectionTitle: 12,
        sectionSub:   8.5,
        label:        7,
        body:         9,
        bodySmall:    8,
        meta:         8,
        footer:       7.5,
        // Hero / tile
        tileLabel:    7,
        tileValue:    14,
        tileUnit:     8,
    },

    /**
     * Fixed-height bands so the body-area math doesn't drift if we tweak
     * content. All in points.
     */
    bands: {
        headerHeight:   38,
        footerHeight:   22,
        sectionBadgeW:  28,
        sectionBadgeH:  28,
    },
} as const;
