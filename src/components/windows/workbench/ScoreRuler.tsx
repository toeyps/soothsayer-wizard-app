import { useId, type ReactNode } from 'react';
import type { HealthSetPoints, IndividualHealthSetPoints } from '../../../types';
import type { HealthIssue, HealthPreview, HealthStats } from '../../../types/health';
import { canResetToMaster, resetToMaster, setPointSource, type SetPointSide } from '../../../utils/healthSetPoints';
import { fmtNumExact } from '../../sensor/sensorInfo';
import { fmtNum } from './chartTheme';
import { fieldState, REL_POINT_LABEL, RING_QUICK, stepRing, type HealthVerdict } from './healthChecks';
import { NumField } from './SetPointsCard';

/*
 * The SCORE RULER of the Health score page ("Workbench detail pages v2"): it
 * replaces the "Health set points" table.
 *
 * One horizontal band reads value → score left to right. Each tick is a value on
 * the sensor's scale and the score the model gives there; the band between two
 * ticks is coloured by those scores (green 100, amber 80, red 0). The program's
 * own ticks (±1SD, ±3SD, ±2RMSE, 1× / 3× SD) are plain mono text; the user's
 * points are the ONLY inputs, large, in the same row — "what do I type and where
 * does it sit" is one picture:
 *
 *   Individual    0 ─── 80 ─── 100 ══ 100 ─── 80 ─── 0
 *                 [L]   −3SD   −1SD     +1SD   +3SD   [H]
 *   Relation      0 ──── 80 ─── 100 ══ 100 ══ 100 ─── 80 ──── 0     (residual = actual − predicted)
 *                 [0 low] [80 low] −2RMSE  0  +2RMSE [80 high] [0 high]
 *   Clustering    100 ═══ 100 ─── 80 ─── 0                          (one-sided: distance from the centre)
 *                 centre  1× SD   3× SD  [N× SD]
 *
 * Ticks are spaced EVENLY (a schematic, not a scale): the values under them say
 * where each one really is.
 *
 * WRONG VALUES WARN. The rules are Rust's (`validation[].field` / `.code`) — this
 * file never decides a value is wrong; it only shows what Rust said:
 *   - a rejected point: its tick, name and input turn red, and a red MARKER sits on
 *     the band where the typed value really is, labelled as typed ("L = 62");
 *   - an empty point: its tick and input are dashed amber;
 *   - the health score did not load: the user's ticks are "not checked" — grey,
 *     dashed, no score colour (never drawn as valid).
 * The Checks (`children`) sit under the ruler in the same card and every input
 * points at them (`aria-describedby`).
 *
 * Presentational: the page keeps the DRAFT set points; the ruler reports every
 * change (`onChange`) and every "done typing" (`onCommit`, on blur / Enter). A
 * discrete action (use master, a stepper click, a quick button) asks for an
 * immediate commit (`onChange(next, true)`).
 */

// ---------------------------------------------------------------------------
// Geometry (pure — unit-tested without layout)
// ---------------------------------------------------------------------------

/** `[value, tick index]`: a tick whose value is known. */
export type RulerAnchor = readonly [value: number, tick: number];

/** `required` = empty (dashed amber) · `error` = rejected (red) · `unchecked` = the
 *  health score did not load, nothing was checked (dashed grey) · `null` = fine. */
export type RulerTickState = 'required' | 'error' | 'unchecked' | null;

export interface RulerTick {
    /** The user's points: Rust's field name (`lower`, `residual_at_80_upper`, `outer_sd`).
     *  The program's ticks: a short id (`m3sd`, `p2rmse`, `ring1`). */
    key: string;
    score: 100 | 80 | 0;
    /** What the tick is ("−3SD", "L", "80 low"). */
    name: string;
    /** The user's own point (an input); otherwise the program's (text). */
    user: boolean;
    state: RulerTickState;
    /** A program tick's value as text. */
    text?: string;
}

/** Where a REJECTED typed value really sits on the ruler. `pos` is in tick units
 *  (0 = the first tick, `ticks.length - 1` = the last). */
export interface RulerMarker {
    /** The point it belongs to (`RulerTick.key`). */
    key: string;
    pos: number;
    /** The value as typed, with the point's name ("L = 62"; "L = 90 →" beyond the end). */
    label: string;
    /** The value lies beyond the user's point at that end of the ruler. */
    beyond?: 'left' | 'right';
}

export interface RulerModel {
    kind: HealthStats['kind'];
    ticks: RulerTick[];
    markers: RulerMarker[];
}

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** A typed number as text: every decimal as typed, a real minus sign. */
const typed = (v: number): string => fmtNumExact(v).replace('-', '−');

/**
 * Position (in tick units) of `v` among `anchors`, which ascend in value AND in tick:
 * linear between two anchors, half a tick outside the first / the last one.
 * `null` when there is no anchor to place it by.
 */
export function positionAmong(v: number, anchors: readonly RulerAnchor[]): number | null {
    if (anchors.length === 0) return null;
    if (v < anchors[0][0]) return anchors[0][1] - 0.5;
    for (let i = 1; i < anchors.length; i++) {
        const [v0, p0] = anchors[i - 1];
        const [v1, p1] = anchors[i];
        if (v <= v1) return v1 === v0 ? p1 : p0 + ((v - v0) / (v1 - v0)) * (p1 - p0);
    }
    const last = anchors[anchors.length - 1];
    return v === last[0] ? last[1] : last[1] + 0.5;
}

/**
 * The anchors a rejected value is placed by: the program's ticks plus the user's
 * OTHER points that are valid — so a marker never lands on the wrong side of one of
 * them. A user point is only taken when its value agrees with the order of the ticks
 * (it lies above every anchor left of it and below every anchor right of it); the
 * result ascends in value and in tick.
 */
export function consistentAnchors(program: readonly RulerAnchor[], user: readonly RulerAnchor[]): RulerAnchor[] {
    const out: RulerAnchor[] = program.filter(a => Number.isFinite(a[0])).sort((a, b) => a[1] - b[1]);
    for (const u of [...user].sort((a, b) => a[1] - b[1])) {
        if (!Number.isFinite(u[0])) continue;
        if (out.every(([v, t]) => (t < u[1] ? v < u[0] : t > u[1] ? v > u[0] : false))) out.push(u);
        out.sort((a, b) => a[1] - b[1]);
    }
    return out;
}

/**
 * The marker of a rejected value `v`. `last` is the index of the ruler's last tick.
 * Past the ruler's end (which only happens beyond the user's own valid point there)
 * the marker sits AT that end and its label carries an arrow.
 */
export function rejectedMarker(key: string, v: number, label: string, anchors: readonly RulerAnchor[], last: number): RulerMarker | null {
    const p = positionAmong(v, anchors);
    if (p === null) return null;
    if (p > last) return { key, pos: last, label: `${label} →`, beyond: 'right' };
    if (p < 0) return { key, pos: 0, label: `← ${label}`, beyond: 'left' };
    return { key, pos: p, label };
}

/** Two marker labels closer than this share of the band's width go on separate rows. */
export const MARKER_MIN_GAP = 0.26;

/** Rows of the marker labels: labels that would overlap are stacked (row 0 = the top one). */
export function markerRows(markers: readonly Pick<RulerMarker, 'pos'>[], last: number): { rows: number; rowOf: number[] } {
    const order = markers.map((_, i) => i).sort((a, b) => markers[a].pos - markers[b].pos);
    const lastPos: number[] = [];
    const rowOf: number[] = new Array(markers.length).fill(0);
    for (const i of order) {
        let r = lastPos.findIndex(p => (markers[i].pos - p) / Math.max(1, last) >= MARKER_MIN_GAP);
        if (r < 0) { r = lastPos.length; lastPos.push(markers[i].pos); } else lastPos[r] = markers[i].pos;
        rowOf[i] = r;
    }
    return { rows: Math.max(1, lastPos.length), rowOf };
}

/** A tick's place on the band, in percent (4 decimals: no float noise in the style). */
const leftOf = (pos: number, last: number): string => `${Number(((pos / Math.max(1, last)) * 100).toFixed(4))}%`;

const SCORE_TONE: Record<RulerTick['score'], 'ok' | 'warn' | 'bad'> = { 100: 'ok', 80: 'warn', 0: 'bad' };
const SCORE_TOKEN: Record<RulerTick['score'], string> = { 100: 'var(--ok)', 80: 'var(--warn)', 0: 'var(--danger)' };

/** The band's background: one colour stop per tick, so each segment fades between the
 *  scores of its two ends. A user point that is empty, rejected or not checked has NO
 *  score colour (grey) — the band never shows a score the model does not give. */
export function bandGradient(ticks: readonly Pick<RulerTick, 'score' | 'user' | 'state'>[]): string {
    const last = ticks.length - 1;
    const stops = ticks.map((t, i) => {
        const colour = t.user && t.state
            ? 'color-mix(in srgb, var(--text-secondary) 35%, transparent)'
            : `color-mix(in srgb, ${SCORE_TOKEN[t.score]} 85%, transparent)`;
        return `${colour} ${leftOf(i, last)}`;
    });
    return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// ---------------------------------------------------------------------------
// The ruler of each kind (pure)
// ---------------------------------------------------------------------------

interface UserPoint { tick: number; key: string; name: string; value: number | null; markerValue?: number; markerLabel?: string }

/** The four Relation-model points in ruler order (low side first). */
export const REL_RULER_POINTS = [
    { key: 'residual_at_0_lower', prop: 'residualAt0Lower', score: 0, tick: 0 },
    { key: 'residual_at_80_lower', prop: 'residualAt80Lower', score: 80, tick: 1 },
    { key: 'residual_at_80_upper', prop: 'residualAt80Upper', score: 80, tick: 5 },
    { key: 'residual_at_0_upper', prop: 'residualAt0Upper', score: 0, tick: 6 },
] as const;

/**
 * The ruler of a model: its ticks (with the state Rust's issues give each user point)
 * and one marker per rejected value. `unchecked` = the health score did not load, so
 * nothing was checked: every user tick is "not checked" and there is no marker.
 * `null` when the set points are not of the model's kind.
 */
export function rulerModel(stats: HealthStats, sp: HealthSetPoints, issues: readonly HealthIssue[], unchecked = false): RulerModel | null {
    const stateOf = (field: string): RulerTickState => (unchecked ? 'unchecked' : fieldState(issues, field));
    const userTick = (key: string, score: RulerTick['score'], name: string): RulerTick => ({ key, score, name, user: true, state: stateOf(key) });
    const build = (ticks: RulerTick[], program: RulerAnchor[], points: UserPoint[]): RulerModel => {
        const last = ticks.length - 1;
        const state = (p: UserPoint) => ticks[p.tick].state;
        const anchors = consistentAnchors(program, points.filter(p => state(p) === null && fin(p.value)).map(p => [p.value as number, p.tick] as const));
        const markers: RulerMarker[] = [];
        for (const p of points) {
            if (state(p) !== 'error' || !fin(p.value)) continue;
            const m = rejectedMarker(p.key, p.markerValue ?? p.value, p.markerLabel ?? `${p.name} = ${typed(p.value)}`, anchors, last);
            if (m) markers.push(m);
        }
        return { kind: stats.kind, ticks, markers };
    };

    if (stats.kind === 'individual' && sp.kind === 'individual') {
        const [l3, u3] = stats.boundary_3sd;
        const [l1, u1] = stats.boundary_1sd;
        return build(
            [
                userTick('lower', 0, 'L'),
                { key: 'm3sd', score: 80, name: '−3SD', user: false, state: null, text: fmtNum(l3) },
                { key: 'm1sd', score: 100, name: '−1SD', user: false, state: null, text: fmtNum(l1) },
                { key: 'p1sd', score: 100, name: '+1SD', user: false, state: null, text: fmtNum(u1) },
                { key: 'p3sd', score: 80, name: '+3SD', user: false, state: null, text: fmtNum(u3) },
                userTick('upper', 0, 'H'),
            ],
            [[l3, 1], [l1, 2], [u1, 3], [u3, 4]],
            [{ tick: 0, key: 'lower', name: 'L', value: sp.lower }, { tick: 5, key: 'upper', name: 'H', value: sp.upper }],
        );
    }
    if (stats.kind === 'relationship' && sp.kind === 'relationship') {
        const w = stats.two_rmse;
        const point = (i: number): RulerTick => userTick(REL_RULER_POINTS[i].key, REL_RULER_POINTS[i].score, REL_POINT_LABEL[REL_RULER_POINTS[i].key]);
        return build(
            [
                point(0),
                point(1),
                { key: 'm2rmse', score: 100, name: '−2RMSE', user: false, state: null, text: `−${fmtNum(w)}` },
                { key: 'zero', score: 100, name: 'no residual', user: false, state: null, text: '0' },
                { key: 'p2rmse', score: 100, name: '+2RMSE', user: false, state: null, text: `+${fmtNum(w)}` },
                point(2),
                point(3),
            ],
            [[-w, 2], [0, 3], [w, 4]],
            REL_RULER_POINTS.map(p => ({ tick: p.tick, key: p.key, name: REL_POINT_LABEL[p.key], value: sp[p.prop] })),
        );
    }
    if (stats.kind === 'clustering' && sp.kind === 'clustering') {
        const n = sp.outerSd;
        return build(
            [
                { key: 'centre', score: 100, name: 'centre', user: false, state: null, text: '0× SD' },
                { key: 'ring1', score: 100, name: '1× SD', user: false, state: null, text: '1×' },
                { key: 'ring3', score: 80, name: '3× SD', user: false, state: null, text: '3×' },
                userTick('outer_sd', 0, 'N× SD'),
            ],
            [[0, 0], [1, 1], [3, 2]],
            // A distance is never negative: a negative N is marked at the centre, labelled as typed.
            [{ tick: 3, key: 'outer_sd', name: 'N', value: n, markerValue: fin(n) ? Math.max(0, n) : undefined, markerLabel: fin(n) ? `N = ${typed(n)}×` : undefined }],
        );
    }
    return null;
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

const TICK_CLASS: Record<Exclude<RulerTickState, null>, string> = {
    error: ' wb3-ruler-tick--bad',
    required: ' wb3-ruler-tick--req',
    unchecked: ' wb3-ruler-tick--unk',
};
const NAME_CLASS: Record<Exclude<RulerTickState, null>, string> = {
    error: ' wb3-ruler-nm--bad',
    required: ' wb3-ruler-nm--req',
    unchecked: '',
};
/** The input's own label on the narrow Relation-model row takes the point's state colour too. */
const VALUE_CLASS: Record<Exclude<RulerTickState, null>, string> = {
    error: ' wb3-ruler-v--bad',
    required: ' wb3-ruler-v--req',
    unchecked: '',
};
const MARK_CLASS: Record<NonNullable<RulerMarker['beyond']>, string> = {
    left: ' wb3-ruler-mark--left',
    right: ' wb3-ruler-mark--right',
};
/** Height of one row of marker labels, px (the CSS row is the same). */
const MARK_ROW = 22;

function Band({ model, inputs }: { model: RulerModel; inputs: Record<string, ReactNode> }) {
    const { ticks, markers, kind } = model;
    const last = ticks.length - 1;
    const { rows, rowOf } = markerRows(markers, last);
    // Relation model: seven ticks leave no room for four inputs on a narrow pane — there
    // the inputs sit on their own labelled row under the band (CSS, by container width),
    // so each input carries its point's name and each program tick its value.
    const splitRow = kind === 'relationship';
    return (
        <div className={`wb3-ruler wb3-ruler--${kind}`} data-testid="score-ruler" data-kind={kind} role="group" aria-label="Health set points on the score ruler">
            {markers.length > 0 && (
                <div className="wb3-ruler-marks" data-testid="ruler-markers" data-rows={rows} style={{ height: rows * MARK_ROW }}>
                    {markers.map((m, i) => (
                        <span
                            key={m.key}
                            className={`wb3-ruler-mark${m.beyond ? MARK_CLASS[m.beyond] : ''}`}
                            data-testid="ruler-marker"
                            data-point={m.key}
                            data-row={rowOf[i]}
                            data-beyond={m.beyond}
                            style={{ left: leftOf(m.pos, last), top: rowOf[i] * MARK_ROW }}
                            title="Where the value you typed sits — it is not accepted there"
                        >
                            {m.label}
                        </span>
                    ))}
                </div>
            )}
            <div className="wb3-ruler-scores" aria-hidden="true">
                {ticks.map((t, i) => (
                    <span key={t.key} className={`wb3-ruler-sc wb3-ruler-sc--${SCORE_TONE[t.score]}${t.user && t.state ? ' wb3-ruler-sc--off' : ''}`} data-tick={t.key} style={{ left: leftOf(i, last) }}>
                        {t.score}
                    </span>
                ))}
            </div>
            <div className="wb3-ruler-band" data-testid="ruler-band" style={{ background: bandGradient(ticks) }}>
                {ticks.map((t, i) => (
                    <i
                        key={t.key}
                        className={`wb3-ruler-tick${t.user ? ' wb3-ruler-tick--user' : ''}${t.state ? TICK_CLASS[t.state] : ''}`}
                        data-testid="ruler-tick"
                        data-tick={t.key}
                        data-state={t.state ?? undefined}
                        style={{ left: leftOf(i, last) }}
                    />
                ))}
                {markers.map((m, i) => (
                    // The stem from the label down to the band, ending in a diamond ON the band.
                    <i key={m.key} className="wb3-ruler-stem" aria-hidden="true" style={{ left: leftOf(m.pos, last), top: -(26 + (rows - 1 - rowOf[i]) * MARK_ROW) }} />
                ))}
            </div>
            <div className="wb3-ruler-names">
                {ticks.map((t, i) => (
                    <span key={t.key} className={`wb3-ruler-nm${t.user ? ' wb3-ruler-nm--user' : ''}${t.state ? NAME_CLASS[t.state] : ''}`} data-testid="ruler-name" data-tick={t.key} style={{ left: leftOf(i, last) }}>
                        {t.name}
                        {splitRow && !t.user && <small className="wb3-ruler-nm-pv" aria-hidden="true">{t.text}</small>}
                    </span>
                ))}
            </div>
            <div className="wb3-ruler-values">
                {ticks.map((t, i) => (
                    <span key={t.key} className={`wb3-ruler-v${t.user ? ' wb3-ruler-v--user' : ''}${t.state ? VALUE_CLASS[t.state] : ''}`} data-testid="ruler-value" data-tick={t.key} style={{ left: leftOf(i, last) }}>
                        {t.user
                            ? <>{splitRow && <small className="wb3-ruler-vl" aria-hidden="true">{t.name}</small>}{inputs[t.key]}</>
                            : t.text}
                    </span>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface ScoreRulerProps {
    data: HealthPreview;
    /** The draft set points being edited (always the model's own kind). */
    setPoints: HealthSetPoints;
    unit: string;
    /** Rust's issues — the source of every point's required / error state. */
    issues: readonly HealthIssue[];
    /** `null` while nothing has been judged yet. */
    verdict: HealthVerdict | null;
    onChange: (next: HealthSetPoints, commit?: boolean) => void;
    onCommit: () => void;
    /** The health score could not be loaded: nothing was checked. The user's ticks are
     *  drawn as "not checked" (grey, dashed, no score colour) — never as valid. */
    unchecked?: boolean;
    /** The Checks, rendered inside this card under the ruler. */
    children?: ReactNode;
    /** Why the set points cannot be edited right now (an export is running): every
     *  input and button of the ruler is disabled, with this as its tooltip. */
    disabledReason?: string | null;
}

/** The card's state dot: colour class (the sensor list's) + the tooltip words. */
const VERDICT_DOT: Record<HealthVerdict, { cls: 'complete' | 'need' | 'bad'; words: string }> = {
    valid: { cls: 'complete', words: 'Set points valid' },
    needs: { cls: 'need', words: 'Set points still empty' },
    bad: { cls: 'bad', words: 'A set point is not valid' },
};

/** What the band means, per kind — the card's subtitle. */
const KIND_NOTE: Record<HealthStats['kind'], string> = {
    individual: 'Score 100 within ±1SD of the learned normal · 80 at ±3SD · 0 at L and H — you set L and H',
    relationship: 'Residual = actual − predicted · 100 within ±2RMSE · you set where 80 and 0 sit on each side',
    clustering: 'Distance from each cluster\'s centre in SD units · 100 inside 1× SD · 80 at 3× SD · 0 at N× SD — you set N',
};

/** Accessible names of the four Relation-model inputs (the names under the band are decoration). */
const REL_INPUT_LABEL: Record<(typeof REL_RULER_POINTS)[number]['key'], string> = {
    residual_at_0_lower: '0 low — the residual where the score reaches 0 on the low side',
    residual_at_80_lower: '80 low — the residual where the score is 80 on the low side',
    residual_at_80_upper: '80 high — the residual where the score is 80 on the high side',
    residual_at_0_upper: '0 high — the residual where the score reaches 0 on the high side',
};

export default function ScoreRuler({ data, setPoints, unit, issues, verdict, onChange, onCommit, unchecked, children, disabledReason = null }: ScoreRulerProps) {
    const off = !!disabledReason;
    const offTitle = disabledReason ?? undefined;
    const checksId = useId();
    // Every input points at the Checks: they say, in words, what its colour means.
    const describedBy = children ? checksId : undefined;
    const model = rulerModel(data.stats, setPoints, issues, !!unchecked);
    // No status pill on this card: one dot in the list's colours, the words in its
    // tooltip. The words themselves are the Checks lines under the ruler.
    const dot = verdict ? VERDICT_DOT[verdict] : null;
    /** The box's own state: Rust's issue for that field (nothing while not checked). */
    const boxState = (field: string) => (unchecked ? null : fieldState(issues, field));

    let inputs: Record<string, ReactNode> = {};
    let note: ReactNode = null;
    if (model && setPoints.kind === 'individual') {
        const sp = setPoints;
        const field = (s: SetPointSide) => (
            <NumField
                big
                testId={`sp-${s}`}
                ariaLabel={s === 'lower' ? 'L — the value where the score reaches 0 on the low side' : 'H — the value where the score reaches 0 on the high side'}
                hint={s === 'lower' ? 'L' : 'H'}
                unit={unit}
                value={s === 'lower' ? sp.lower : sp.upper}
                state={boxState(s)}
                describedBy={describedBy}
                disabledReason={disabledReason}
                onChange={v => onChange({ ...sp, [s]: v })}
                onCommit={onCommit}
            />
        );
        inputs = { lower: field('lower'), upper: field('upper') };
        note = <MasterNote sp={sp} onChange={onChange} disabledReason={disabledReason} />;
    } else if (model && setPoints.kind === 'relationship') {
        const sp = setPoints;
        // The four points start EMPTY (no defaults); the placeholder only shows the side's sign.
        for (const p of REL_RULER_POINTS) {
            inputs[p.key] = (
                <NumField
                    big
                    testId={`sp-${p.key}`}
                    ariaLabel={REL_INPUT_LABEL[p.key]}
                    hint={p.key.endsWith('_lower') ? '−' : '+'}
                    unit={unit}
                    value={sp[p.prop]}
                    state={boxState(p.key)}
                    describedBy={describedBy}
                    disabledReason={disabledReason}
                    onChange={v => onChange({ ...sp, [p.prop]: v })}
                    onCommit={onCommit}
                />
            );
        }
        note = (
            <div className="wb3-ruler-note" data-testid="sign-note">
                The low points are negative, the high points positive. Each 0 point sits further from zero than its 80 point.
            </div>
        );
    } else if (model && setPoints.kind === 'clustering') {
        const sp = setPoints;
        const set = (n: number | null, commit?: boolean) => onChange({ ...sp, outerSd: n }, commit);
        inputs = {
            outer_sd: (
                <span className="hs-kstep" data-testid="ring-control">
                    <button type="button" data-testid="ring-dec" aria-label="Smaller" disabled={off} title={offTitle} onClick={() => set(stepRing(sp.outerSd, -1), true)}>−</button>
                    <NumField
                        big
                        wide
                        testId="sp-outer_sd"
                        ariaLabel="Outer ring in × SD"
                        unit=""
                        suffix="× SD"
                        hint="N"
                        value={sp.outerSd}
                        state={boxState('outer_sd')}
                        describedBy={describedBy}
                        disabledReason={disabledReason}
                        onChange={v => set(v)}
                        onCommit={onCommit}
                    />
                    <button type="button" data-testid="ring-inc" aria-label="Larger" disabled={off} title={offTitle} onClick={() => set(stepRing(sp.outerSd, 1), true)}>+</button>
                </span>
            ),
        };
        note = (
            <div className="wb3-ruler-note" data-testid="ring-note">
                <span className="hs-quick" data-testid="ring-quick">
                    {RING_QUICK.map(q => (
                        <button key={q} type="button" data-testid={`ring-quick-${q}`} className={sp.outerSd === q ? 'on' : ''} aria-pressed={sp.outerSd === q} disabled={off} title={offTitle} onClick={() => set(q, true)}>{q}×</button>
                    ))}
                </span>
                <span>One N for every cluster: each cluster gets its own 1×, 3× and N× rings, sized by its own SD.</span>
            </div>
        );
    }

    return (
        <section className="hs-card wb3-rulercard" data-testid="set-points-card">
            <div className="wb2-card-h">
                <b>Health set points</b>
                <span className="wb2-card-s" data-testid="ruler-kind-note">{KIND_NOTE[data.stats.kind]}</span>
                <span className="wb2-sp" />
                {dot && <span className={`f4-sdot f4-sdot--${dot.cls}`} data-testid="hs-verdict" data-verdict={verdict ?? undefined} role="img" title={dot.words} aria-label={dot.words} />}
            </div>
            {model && <Band model={model} inputs={inputs} />}
            {model && note}
            {children && <div className="wb3-ruler-checks" id={checksId}>{children}</div>}
        </section>
    );
}

/** Individual: ONE footnote for both sides — where L / H come from, and the master-data
 *  rule. A "Use master …" link shows only for a side that differs from the master data. */
function MasterNote({ sp, onChange, disabledReason }: { sp: IndividualHealthSetPoints; onChange: ScoreRulerProps['onChange']; disabledReason: string | null }) {
    const srcL = setPointSource(sp, 'lower');
    const srcU = setPointSource(sp, 'upper');
    const words = (letter: 'L' | 'H', src: ReturnType<typeof setPointSource>) =>
        src === 'model' ? `${letter} is set on this model` : src === 'master' ? `${letter} comes from the master data` : `${letter} is not in the master data`;
    const origin = srcL === 'master' && srcU === 'master' ? 'L and H come from the master data alarm limits.'
        : srcL === 'not-in-master' && srcU === 'not-in-master' ? 'The master data has no alarm limits for this sensor — type L and H.'
        : `${words('L', srcL)} · ${words('H', srcU)}.`;
    const reset = (s: SetPointSide) => {
        const master = s === 'lower' ? sp.masterLower : sp.masterUpper;
        if (typeof master !== 'number' || !canResetToMaster(sp, s)) return null;
        return (
            <button key={s} type="button" className="hs-restore" data-testid={`sp-${s}-reset`} disabled={!!disabledReason} title={disabledReason ?? undefined} onClick={() => onChange(resetToMaster(sp, s), true)}>
                Use master {s === 'lower' ? 'L' : 'H'} {fmtNumExact(master)}
            </button>
        );
    };
    const resets = [reset('lower'), reset('upper')].filter(Boolean);
    return (
        <div className="wb3-ruler-note" data-testid="master-note">
            <span data-testid="master-origin" data-lower={srcL} data-upper={srcU}>{origin}</span>
            {' '}Saved on this model only; the master data is not changed.
            {resets.length > 0 && <>{' '}{resets[0]}{resets.length > 1 && <>{' · '}{resets[1]}</>}</>}
        </div>
    );
}
