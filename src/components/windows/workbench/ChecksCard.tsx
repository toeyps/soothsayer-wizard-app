import { Check, Minus, X } from 'lucide-react';
import type { HealthIssue, HealthPreview } from '../../../types/health';
import { buildCheckLines, type HealthVerdict } from './healthChecks';

/*
 * The Checks of the Health score page. They live INSIDE the "Health set points"
 * card, under the score ruler (one card, no second header) — `ScoreRuler` renders
 * this as its children, and every ruler input points at it (`aria-describedby`).
 * It shows what Rust's
 * `validation` list says (`compute_health_preview` re-validates on every call,
 * including once more when Mark complete is pressed) - the page
 * never re-implements a rule. Valid: one green line. Otherwise: one line per
 * problem; for Relationship several empty points collapse into ONE line.
 */

export interface ChecksCardProps {
    kind: HealthPreview['kind'];
    issues: readonly HealthIssue[];
    verdict: HealthVerdict | null;
    /** The health score could not be loaded: say nothing is being checked. */
    unavailable?: boolean;
    /** S-number of each scoring period that was SENT
     *  (`testPeriodsWirePlan(...).numbers`), so an issue about one of them names
     *  the period the user sees. */
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
