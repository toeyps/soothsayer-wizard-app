import { useEffect, useState, type ReactNode } from 'react';
import type {
    ClusteringHealthSetPoints,
    HealthSetPoints,
    IndividualHealthSetPoints,
    RelationshipHealthSetPoints,
} from '../../../types';
import type { HealthIssue, HealthPreview } from '../../../types/health';
import { canResetToMaster, resetToMaster, setPointSource, type SetPointSide } from '../../../utils/healthSetPoints';
import { fmtNumExact } from '../../sensor/sensorInfo';
import { fmtNumCol } from './chartTheme';
import { fieldState, formatSetPointText, RING_QUICK, stepRing, type FieldState, type HealthVerdict } from './healthChecks';

/*
 * The "Health set points" card of the Health score page (SPEC workbench-redesign
 * §4): ONE small table instead of a ladder of boxed rungs, with the Checks in
 * the same card.
 *
 *   SCORE  BAND                        LOWER     UPPER
 *   100    within ±1SD · automatic     65.58     72.46      plain text
 *    80    at ±3SD · automatic         58.69     79.35      plain text
 *     0    at L / H                    [ 40 ]    [ 85 ]     the only inputs
 *          one footnote: where L / H come from, "saved on this model only"
 *   ─────
 *   the Checks (`children`) — the same card, no second header
 *
 * Values the program computes are plain TEXT (`fmtNumCol` — the computed-value format
 * with a fixed 3 decimals, so the Lower / Upper columns line up): nothing that looks like
 * an input is one. The user's points are the only boxes; they keep the user's
 * own text while typing, and a typed value shown as text (the "Use master H 4.5"
 * link) is printed in its exact shortest form (`fmtNumExact` — never padded to
 * "4.50", never rounded).
 *
 * Presentational: the page keeps the DRAFT set points and this card reports
 * every change (`onChange`) and every "done typing" (`onCommit`, on blur / Enter).
 * A discrete action (use master, a stepper click, a quick button) asks for an
 * immediate commit (`onChange(next, true)`).
 *
 * Which inputs are "required" (dashed amber) / "error" (red) comes ONLY from
 * Rust's `validation[].field`; this card never decides a value is wrong.
 */

export interface SetPointsCardProps {
    data: HealthPreview;
    /** The draft set points being edited (always the model's own kind). */
    setPoints: HealthSetPoints;
    unit: string;
    /** Rust's issues - the source of every input's required / error state. */
    issues: readonly HealthIssue[];
    /** `null` while nothing has been judged yet. */
    verdict: HealthVerdict | null;
    onChange: (next: HealthSetPoints, commit?: boolean) => void;
    onCommit: () => void;
    /** The Checks, rendered inside this card under the table. */
    children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Number input
// ---------------------------------------------------------------------------

function parseNum(text: string): number | null {
    const t = text.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

const toText = (v: number | null): string => (v === null ? '' : formatSetPointText(v));

interface NumFieldProps {
    testId: string;
    /** The input's accessible name (the table's column heads are decoration). */
    ariaLabel: string;
    unit: string;
    value: number | null;
    state: FieldState;
    onChange: (v: number | null) => void;
    onCommit: () => void;
    /** A suffix text instead of the unit (e.g. "× SD"). */
    suffix?: string;
    /** The wider box of the outer-ring field. */
    wide?: boolean;
    /** Placeholder while empty: what goes in the box, in one or two characters ("L" / "H",
     *  the side's sign for a Relation-model point, "N") — a word would not fit the column.
     *  "Required" is said by the dashed amber box and `aria-required`. */
    hint: string;
}

/** A number input with its own text state, so "-", "1." and "" can be typed
 *  without the field fighting the parsed number. */
function NumField({ testId, ariaLabel, unit, value, state, onChange, onCommit, suffix, wide, hint }: NumFieldProps) {
    const [text, setText] = useState(toText(value));
    // The draft changed from outside (use master, a stepper, a broadcast): follow
    // it - but never rewrite what the user is typing when it parses to the value
    // we already have ("2.50" stays "2.50").
    useEffect(() => {
        if (parseNum(text) !== value) setText(toText(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    const cls = state === 'error' ? ' hs-num--err' : state === 'required' ? ' hs-num--req' : '';
    return (
        <span className={`hs-num${wide ? ' hs-num--ring' : ''}${cls}`}>
            <input
                id={testId}
                data-testid={testId}
                aria-label={ariaLabel}
                value={text}
                inputMode="decimal"
                placeholder={hint}
                aria-required={state === 'required' ? true : undefined}
                aria-invalid={state === 'error' ? true : undefined}
                onChange={e => { setText(e.target.value); onChange(parseNum(e.target.value)); }}
                onBlur={onCommit}
                onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
            />
            <span>{suffix ?? unit}</span>
        </span>
    );
}

/** A value the program computed: plain text, never a box. */
const Ro = ({ children, testId }: { children: ReactNode; testId?: string }) => (
    <span className="hsx-ro" data-testid={testId}>{children}</span>
);

/** "within ±1SD · automatic": what the band is, and who sets it. */
const Band = ({ what, who }: { what: string; who: string }) => (
    // The space sits BETWEEN the two no-wrap parts, so a narrow column breaks there and nowhere else.
    <><span>{what}</span>{' '}<small>· {who}</small></>
);

/** One row of the table: the score, its band, and the two side values. */
function Row({ score, tone, band, lower, upper, testId }: {
    score: number;
    tone: 'ok' | 'warn' | 'danger';
    band: ReactNode;
    lower?: ReactNode;
    upper?: ReactNode;
    testId: string;
}) {
    return (
        <div className={`hsx-row hsx-row--${tone}`} role="row" data-testid={testId}>
            <span className="hsx-score" role="rowheader">{score}</span>
            <span className="hsx-what" role="cell">{band}</span>
            <span className="hsx-v" role="cell">{lower}</span>
            {upper !== undefined && <span className="hsx-v" role="cell">{upper}</span>}
        </div>
    );
}

/** The card's state dot: colour class (the sensor list's) + the tooltip words. */
const VERDICT_DOT: Record<HealthVerdict, { cls: 'complete' | 'need' | 'bad'; words: string }> = {
    valid: { cls: 'complete', words: 'Set points valid' },
    needs: { cls: 'need', words: 'Set points still empty' },
    bad: { cls: 'bad', words: 'A set point is not valid' },
};

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export default function SetPointsCard(props: SetPointsCardProps) {
    const { data, setPoints, verdict, children } = props;
    // No status pill on this card (SPEC workbench-redesign §1): one dot in the list's
    // colours, the words in its tooltip. The words themselves are the Checks lines
    // below and the footer sentence.
    const dot = verdict ? VERDICT_DOT[verdict] : null;
    const head = verdict && dot
        ? <span className={`f4-sdot f4-sdot--${dot.cls}`} data-testid="hs-verdict" data-verdict={verdict} role="img" title={dot.words} aria-label={dot.words} />
        : null;
    return (
        <section className="hs-card hsx-card" data-testid="set-points-card">
            <div className="wb2-card-h"><b>Health set points</b><span className="wb2-sp" />{head}</div>
            {data.stats.kind === 'individual' && setPoints.kind === 'individual' && <IndividualRows {...props} data={data} sp={setPoints} />}
            {data.stats.kind === 'relationship' && setPoints.kind === 'relationship' && <RelationshipRows {...props} data={data} sp={setPoints} />}
            {data.stats.kind === 'clustering' && setPoints.kind === 'clustering' && <ClusteringRows {...props} sp={setPoints} />}
            {children && <div className="hsx-checks">{children}</div>}
        </section>
    );
}

/** The table itself: `Score · Band · Lower · Upper` (Clustering has one value
 *  column, so its head row is left out). Footnotes and the ring control sit
 *  under it, outside the table. */
function Table({ sides, children }: { sides: boolean; children: ReactNode }) {
    return (
        <div className={`hsx-table${sides ? '' : ' hsx-table--cl'}`} role="table" aria-label="Health set points" data-testid="hs-ladder">
            {sides && (
                <div className="hsx-row hsx-head" role="row">
                    <span role="columnheader">Score</span>
                    <span role="columnheader">Band</span>
                    <span role="columnheader">Lower</span>
                    <span role="columnheader">Upper</span>
                </div>
            )}
            {children}
        </div>
    );
}

type RowsProps<S extends HealthSetPoints> = SetPointsCardProps & { sp: S };

function IndividualRows({ data, sp, unit, issues, onChange, onCommit }: RowsProps<IndividualHealthSetPoints>) {
    if (data.stats.kind !== 'individual') return null;
    const st = data.stats;
    const field = (s: SetPointSide) => (
        <NumField
            key={s}
            testId={`sp-${s}`}
            ariaLabel={s === 'lower' ? 'L — the value where the score reaches 0 on the low side' : 'H — the value where the score reaches 0 on the high side'}
            hint={s === 'lower' ? 'L' : 'H'}
            unit={unit}
            value={s === 'lower' ? sp.lower : sp.upper}
            state={fieldState(issues, s)}
            onChange={v => onChange({ ...sp, [s]: v })}
            onCommit={onCommit}
        />
    );
    // ONE footnote for both sides: where L / H come from, and the master-data rule.
    // A "Use master …" link shows only for a side that differs from the master data.
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
            <button key={s} type="button" className="hs-restore" data-testid={`sp-${s}-reset`} onClick={() => onChange(resetToMaster(sp, s), true)}>
                Use master {s === 'lower' ? 'L' : 'H'} {fmtNumExact(master)}
            </button>
        );
    };
    const resets = [reset('lower'), reset('upper')].filter(Boolean);
    return (
        <>
            <Table sides>
                <Row score={100} tone="ok" testId="rung-100" band={<Band what="within ±1SD" who="automatic" />}
                    lower={<Ro testId="ro-l1">{fmtNumCol(st.boundary_1sd[0])}</Ro>} upper={<Ro testId="ro-u1">{fmtNumCol(st.boundary_1sd[1])}</Ro>} />
                <Row score={80} tone="warn" testId="rung-80" band={<Band what="at ±3SD" who="automatic" />}
                    lower={<Ro testId="ro-l3">{fmtNumCol(st.boundary_3sd[0])}</Ro>} upper={<Ro testId="ro-u3">{fmtNumCol(st.boundary_3sd[1])}</Ro>} />
                <Row score={0} tone="danger" testId="rung-0" band={<Band what="at L / H" who="you set them" />}
                    lower={field('lower')} upper={field('upper')} />
            </Table>
            <div className="hsx-note" data-testid="master-note">
                <span data-testid="master-origin" data-lower={srcL} data-upper={srcU}>{origin}</span>
                {' '}Saved on this model only; the master data is not changed.
                {resets.length > 0 && <>{' '}{resets[0]}{resets.length > 1 && <>{' · '}{resets[1]}</>}</>}
            </div>
        </>
    );
}

function RelationshipRows({ data, sp, unit, issues, onChange, onCommit }: RowsProps<RelationshipHealthSetPoints>) {
    if (data.stats.kind !== 'relationship') return null;
    const w = data.stats.two_rmse;
    // The four points start EMPTY (no defaults); the placeholder only shows the side's sign.
    const field = (key: keyof Omit<RelationshipHealthSetPoints, 'kind'>, wire: string, label: string) => (
        <NumField
            testId={`sp-${wire}`}
            ariaLabel={label}
            hint={wire.endsWith('_lower') ? '−' : '+'}
            unit={unit}
            value={sp[key]}
            state={fieldState(issues, wire)}
            onChange={v => onChange({ ...sp, [key]: v })}
            onCommit={onCommit}
        />
    );
    return (
        <>
            <Table sides>
                <Row score={100} tone="ok" testId="rung-100" band={<Band what="within ±2RMSE" who="automatic" />}
                    lower={<Ro testId="ro-l2">−{fmtNumCol(w)}</Ro>} upper={<Ro testId="ro-u2">+{fmtNumCol(w)}</Ro>} />
                <Row score={80} tone="warn" testId="rung-80" band={<Band what="residual at 80" who="you set them" />}
                    lower={field('residualAt80Lower', 'residual_at_80_lower', 'Lower residual at score 80')}
                    upper={field('residualAt80Upper', 'residual_at_80_upper', 'Upper residual at score 80')} />
                <Row score={0} tone="danger" testId="rung-0" band={<Band what="residual at 0" who="you set them" />}
                    lower={field('residualAt0Lower', 'residual_at_0_lower', 'Lower residual at score 0')}
                    upper={field('residualAt0Upper', 'residual_at_0_upper', 'Upper residual at score 0')} />
            </Table>
            <div className="hsx-note" data-testid="sign-note">
                Residual = actual − predicted: lower points are negative, upper points positive. 0 sits further from zero than 80.
            </div>
        </>
    );
}

function ClusteringRows({ sp, issues, onChange, onCommit }: RowsProps<ClusteringHealthSetPoints>) {
    const state = fieldState(issues, 'outer_sd');
    const set = (n: number | null, commit?: boolean) => onChange({ ...sp, outerSd: n }, commit);
    return (
        <>
            {/* The 1× and 3× rows are text; N is the one control, on its own line under the table. */}
            <Table sides={false}>
                <Row score={100} tone="ok" testId="rung-100" band={<Band what="inside the 1× SD ring" who="automatic" />} lower={<Ro testId="ro-1x">1× SD</Ro>} />
                <Row score={80} tone="warn" testId="rung-80" band={<Band what="on the 3× SD ring" who="automatic" />} lower={<Ro testId="ro-3x">3× SD</Ro>} />
                <Row score={0} tone="danger" testId="rung-0" band={<Band what="on the N× SD ring" who="you set N · more than 3" />} lower={<Ro testId="ro-nx">{sp.outerSd !== null && Number.isFinite(sp.outerSd) ? fmtNumExact(sp.outerSd) : 'N'}× SD</Ro>} />
            </Table>
            <div className="hsx-ctl" data-testid="ring-control">
                <span className="hs-kstep">
                    <button type="button" data-testid="ring-dec" aria-label="Smaller" onClick={() => set(stepRing(sp.outerSd, -1), true)}>−</button>
                    <NumField
                        wide
                        testId="sp-outer_sd"
                        ariaLabel="Outer ring in × SD"
                        unit=""
                        suffix="× SD"
                        hint="N"
                        value={sp.outerSd}
                        state={state}
                        onChange={v => set(v)}
                        onCommit={onCommit}
                    />
                    <button type="button" data-testid="ring-inc" aria-label="Larger" onClick={() => set(stepRing(sp.outerSd, 1), true)}>+</button>
                </span>
                <span className="hs-quick">
                    {RING_QUICK.map(q => (
                        <button key={q} type="button" data-testid={`ring-quick-${q}`} className={sp.outerSd === q ? 'on' : ''} aria-pressed={sp.outerSd === q} onClick={() => set(q, true)}>{q}×</button>
                    ))}
                </span>
            </div>
            <div className="hsx-note">One N for every cluster: each cluster gets its own 1×, 3× and N× rings, sized by its own SD.</div>
        </>
    );
}
