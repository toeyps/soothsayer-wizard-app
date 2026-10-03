import { useEffect, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type {
    ClusteringHealthSetPoints,
    HealthSetPoints,
    IndividualHealthSetPoints,
    RelationshipHealthSetPoints,
} from '../../../types';
import type { HealthIssue, HealthPreview } from '../../../types/health';
import { canResetToMaster, resetToMaster, setPointSource, type SetPointSide } from '../../../utils/healthSetPoints';
import { fmtNum } from './chartTheme';
import { fieldState, RING_QUICK, stepRing, type FieldState, type HealthVerdict } from './healthChecks';

/*
 * The "Health set points" card of the Health score page (mockup `panel()`): the
 * 100 / 80 / 0 ladder of the model's kind. Values the program computes are
 * read-only with a lock; the user's points are number inputs.
 *
 * Presentational: the page keeps the DRAFT set points and this card reports
 * every change (`onChange`) and every "done typing" (`onCommit`, on blur / Enter).
 * A discrete action (reset to master, a stepper click, a quick button) asks
 * for an immediate commit (`onChange(next, true)`).
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

const toText = (v: number | null): string => (v === null ? '' : String(+v.toFixed(6)));

interface NumFieldProps {
    testId: string;
    label: string;
    unit: string;
    value: number | null;
    state: FieldState;
    onChange: (v: number | null) => void;
    onCommit: () => void;
    extra?: ReactNode;
    /** A suffix text instead of the unit (e.g. "× SD"). */
    suffix?: string;
    /** Only the input box, without the label row (the outer-ring field). */
    bare?: boolean;
    ariaLabel?: string;
}

/** A number input with its own text state, so "-", "1." and "" can be typed
 *  without the field fighting the parsed number. */
function NumField({ testId, label, unit, value, state, onChange, onCommit, extra, suffix, bare, ariaLabel }: NumFieldProps) {
    const [text, setText] = useState(toText(value));
    // The draft changed from outside (reset to master, a stepper, a broadcast):
    // follow it - but never rewrite what the user is typing when it parses to the
    // value we already have.
    useEffect(() => {
        if (parseNum(text) !== value) setText(toText(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    const cls = state === 'error' ? ' hs-num--err' : state === 'required' ? ' hs-num--req' : '';
    const box = (
        <span className={`hs-num${bare ? ' hs-num--ring' : ''}${cls}`}>
            <input
                id={testId}
                data-testid={testId}
                aria-label={ariaLabel}
                value={text}
                inputMode="decimal"
                placeholder={state === 'required' ? 'Required' : ''}
                aria-invalid={state === 'error' ? true : undefined}
                onChange={e => { setText(e.target.value); onChange(parseNum(e.target.value)); }}
                onBlur={onCommit}
                onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
            />
            <span>{suffix ?? unit}</span>
        </span>
    );
    if (bare) return box;
    return (
        <div className="hs-fld">
            <label htmlFor={testId}>{label}{extra}</label>
            {box}
        </div>
    );
}

const Locked = ({ label }: { label: string }) => (
    <span className="hs-lock"><Lock size={11} aria-hidden="true" />{label}</span>
);

const Ro = ({ children, testId }: { children: ReactNode; testId?: string }) => (
    <span className="hs-ro" data-testid={testId}>{children}</span>
);

function Rung({ score, tone, what, children, testId }: { score: number; tone: 'ok' | 'warn' | 'danger'; what: ReactNode; children?: ReactNode; testId: string }) {
    return (
        <div className="hs-rung" data-testid={testId}>
            <span className={`hs-sc hs-sc--${tone}`}>{score}<small>score</small></span>
            <div>
                <div className="hs-what">{what}</div>
                {children}
            </div>
        </div>
    );
}

const SOURCE_CHIP: Record<ReturnType<typeof setPointSource>, { cls: string; text: string }> = {
    master: { cls: 'hs-src--m', text: 'master data' },
    model: { cls: 'hs-src--c', text: 'this model' },
    'not-in-master': { cls: 'hs-src--n', text: 'not in master' },
};

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export default function SetPointsCard(props: SetPointsCardProps) {
    const { data, setPoints, verdict } = props;
    const head = verdict === 'valid'
        ? <span className="f4-pill f4-pill--ok" data-testid="hs-verdict">Valid</span>
        : verdict === 'bad'
            ? <span className="f4-pill f4-pill--bad" data-testid="hs-verdict">Not valid</span>
            : verdict === 'needs'
                ? <span className="f4-pill f4-pill--warn" data-testid="hs-verdict">Incomplete</span>
                : null;
    return (
        <section className="hs-card" data-testid="set-points-card">
            <div className="wb2-card-h"><b>Health set points</b><span className="wb2-sp" />{head}</div>
            <div className="hs-ladder">
                {data.stats.kind === 'individual' && setPoints.kind === 'individual' && <IndividualLadder {...props} data={data} sp={setPoints} />}
                {data.stats.kind === 'relationship' && setPoints.kind === 'relationship' && <RelationshipLadder {...props} data={data} sp={setPoints} />}
                {data.stats.kind === 'clustering' && setPoints.kind === 'clustering' && <ClusteringLadder {...props} sp={setPoints} />}
            </div>
        </section>
    );
}

type LadderProps<S extends HealthSetPoints> = SetPointsCardProps & { sp: S };

function IndividualLadder({ data, sp, unit, issues, onChange, onCommit }: LadderProps<IndividualHealthSetPoints>) {
    if (data.stats.kind !== 'individual') return null;
    const st = data.stats;
    const side = (s: SetPointSide) => {
        const label = s === 'lower' ? 'L' : 'H';
        const master = s === 'lower' ? sp.masterLower : sp.masterUpper;
        const src = SOURCE_CHIP[setPointSource(sp, s)];
        const showReset = typeof master === 'number' && canResetToMaster(sp, s);
        return (
            <NumField
                key={s}
                testId={`sp-${s}`}
                label={label}
                unit={unit}
                value={s === 'lower' ? sp.lower : sp.upper}
                state={fieldState(issues, s)}
                onChange={v => onChange({ ...sp, [s]: v })}
                onCommit={onCommit}
                extra={<>
                    {' '}<span className={`hs-src ${src.cls}`} data-testid={`sp-${s}-source`}>{src.text}</span>
                    {showReset && (
                        <>
                            {' '}
                            <button type="button" className="hs-restore" data-testid={`sp-${s}-reset`} onClick={() => onChange(resetToMaster(sp, s), true)}>
                                use {fmtNum(master as number)}
                            </button>
                        </>
                    )}
                </>}
            />
        );
    };
    return (
        <>
            <Rung score={100} tone="ok" testId="rung-100" what={<>Within ±1SD <Locked label="auto" /></>}>
                <div className="hs-pair"><Ro testId="ro-l1">{fmtNum(st.boundary_1sd[0])}</Ro><Ro testId="ro-u1">{fmtNum(st.boundary_1sd[1])}</Ro></div>
            </Rung>
            <Rung score={80} tone="warn" testId="rung-80" what={<>At ±3SD <Locked label="auto" /></>}>
                <div className="hs-pair"><Ro testId="ro-l3">{fmtNum(st.boundary_3sd[0])}</Ro><Ro testId="ro-u3">{fmtNum(st.boundary_3sd[1])}</Ro></div>
            </Rung>
            <Rung score={0} tone="danger" testId="rung-0" what="At setpoint L / H">
                <div className="hs-pair">{side('lower')}{side('upper')}</div>
            </Rung>
        </>
    );
}

function RelationshipLadder({ data, sp, unit, issues, onChange, onCommit }: LadderProps<RelationshipHealthSetPoints>) {
    if (data.stats.kind !== 'relationship') return null;
    const w = data.stats.two_rmse;
    const field = (key: keyof Omit<RelationshipHealthSetPoints, 'kind'>, wire: string, label: string) => (
        <NumField
            testId={`sp-${wire}`}
            label={label}
            unit={unit}
            value={sp[key]}
            state={fieldState(issues, wire)}
            onChange={v => onChange({ ...sp, [key]: v })}
            onCommit={onCommit}
        />
    );
    return (
        <>
            <Rung score={100} tone="ok" testId="rung-100" what={<>Within ±2RMSE <Locked label="from training" /></>}>
                <div className="hs-pair"><Ro testId="ro-l2">−{fmtNum(w)}</Ro><Ro testId="ro-u2">+{fmtNum(w)}</Ro></div>
            </Rung>
            <Rung score={80} tone="warn" testId="rung-80" what="Residual at score 80">
                <div className="hs-pair">
                    {field('residualAt80Lower', 'residual_at_80_lower', 'Lower')}
                    {field('residualAt80Upper', 'residual_at_80_upper', 'Upper')}
                </div>
            </Rung>
            <Rung score={0} tone="danger" testId="rung-0" what="Residual at score 0">
                <div className="hs-pair">
                    {field('residualAt0Lower', 'residual_at_0_lower', 'Lower')}
                    {field('residualAt0Upper', 'residual_at_0_upper', 'Upper')}
                </div>
            </Rung>
        </>
    );
}

function ClusteringLadder({ sp, issues, onChange, onCommit }: LadderProps<ClusteringHealthSetPoints>) {
    const state = fieldState(issues, 'outer_sd');
    const set = (n: number | null, commit?: boolean) => onChange({ ...sp, outerSd: n }, commit);
    return (
        <>
            <Rung score={100} tone="ok" testId="rung-100" what={<>Inside the 1× SD ring <Locked label="auto" /></>} />
            <Rung score={80} tone="warn" testId="rung-80" what={<>On the 3× SD ring <Locked label="auto" /></>} />
            <Rung score={0} tone="danger" testId="rung-0" what="Outer ring — N× SD (more than 3)">
                <div className="hs-kstep">
                    <button type="button" data-testid="ring-dec" aria-label="Smaller" onClick={() => set(stepRing(sp.outerSd, -1), true)}>−</button>
                    <NumField
                        bare
                        testId="sp-outer_sd"
                        ariaLabel="Outer ring in × SD"
                        label="Outer ring"
                        unit=""
                        suffix="× SD"
                        value={sp.outerSd}
                        state={state}
                        onChange={v => set(v)}
                        onCommit={onCommit}
                    />
                    <button type="button" data-testid="ring-inc" aria-label="Larger" onClick={() => set(stepRing(sp.outerSd, 1), true)}>+</button>
                </div>
                <div className="hs-quick">
                    {RING_QUICK.map(q => (
                        <button key={q} type="button" data-testid={`ring-quick-${q}`} className={sp.outerSd === q ? 'on' : ''} aria-pressed={sp.outerSd === q} onClick={() => set(q, true)}>{q}×</button>
                    ))}
                </div>
                <div className="hs-note">One number for every cluster. Each cluster gets 3 rings: 1×, 3× and N× its own SD.</div>
            </Rung>
        </>
    );
}
