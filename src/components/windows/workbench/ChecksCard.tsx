import { Check, Minus, X } from 'lucide-react';
import type { HealthIssue, HealthPreview } from '../../../types/health';
import { buildCheckLines, type HealthVerdict } from './healthChecks';

/* Checks of the Health score page, inside the 'Health set points' card under the ruler. Shows Rust's `validation` list; no rule is re-implemented here. Valid: one green line. Otherwise one line per problem; for Relationship, several empty points collapse into one line. */

export interface ChecksCardProps {
    kind: HealthPreview['kind'];
    issues: readonly HealthIssue[];
    verdict: HealthVerdict | null;
    /** The health score could not be loaded: say nothing is being checked. */
    unavailable?: boolean;
    /** S-number of each sent scoring period (`testPeriodsWirePlan(...).numbers`), so an issue names the period the user sees. */
    testNumbers?: readonly number[] | null;
}

const ICON = { need: Minus, bad: X } as const;

export default function ChecksCard({ kind, issues, verdict, unavailable, testNumbers }: ChecksCardProps) {
    const lines = buildCheckLines(kind, issues, testNumbers);
    return (
        <div role="group" aria-label="Checks" data-testid="checks-card">
            {unavailable ? (
                <div className="hs-note" data-testid="checks-unavailable">Not available until the health score loads.</div>
            ) : lines.length > 0 || verdict === 'valid' ? (
                <div className="hs-checks" role="list">
                    {/* Valid = the green line, even when Rust adds non-blocking warnings below it. */}
                    {verdict === 'valid' && (
                        <div role="listitem" className="hs-chk hs-chk--ok" data-testid="check-valid">
                            <span className="hs-ic"><Check size={10} strokeWidth={3} aria-hidden="true" /></span>
                            <span>Every set point passes the checks — the score is below.</span>
                        </div>
                    )}
                    {lines.map(l => {
                        const Icon = ICON[l.tone];
                        return (
                            <div key={l.key} role="listitem" className={`hs-chk hs-chk--${l.tone}`} data-testid="check-line" data-tone={l.tone} data-warning={l.warning ? 'true' : undefined}>
                                <span className="hs-ic"><Icon size={10} strokeWidth={3} aria-hidden="true" /></span>
                                <span>
                                    {l.warning && <b>Note: </b>}
                                    {l.text}
                                    {l.warning && <span className="hs-fix">This does not stop you from marking the model complete.</span>}
                                    {l.fix && <span className="hs-fix">{l.fix}</span>}
                                </span>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="hs-note" data-testid="checks-pending">Checking the set points…</div>
            )}
        </div>
    );
}
