import { Check, Minus, X } from 'lucide-react';
import type { HealthIssue, HealthPreview } from '../../../types/health';
import { buildCheckLines, type HealthVerdict } from './healthChecks';

/*
 * The "Checks" card of the Health score page. It shows what Rust's
 * `validation` list says (`compute_health_preview` re-validates on every call,
 * and `export_model_files` once more when Mark complete is pressed) - the page
 * never re-implements a rule. Valid: one green line. Otherwise: one line per
 * problem; for Relationship several empty points collapse into ONE line.
 */

export interface ChecksCardProps {
    kind: HealthPreview['kind'];
    issues: readonly HealthIssue[];
    verdict: HealthVerdict | null;
}

const ICON = { need: Minus, bad: X } as const;

export default function ChecksCard({ kind, issues, verdict }: ChecksCardProps) {
    const lines = buildCheckLines(kind, issues);
    return (
        <section className="hs-card" data-testid="checks-card">
            <div className="wb2-card-h"><b>Checks</b></div>
            {verdict === 'valid' && lines.length === 0 ? (
                <div className="hs-checks">
                    <div className="hs-chk hs-chk--ok" data-testid="check-valid">
                        <span className="hs-ic"><Check size={10} strokeWidth={3} aria-hidden="true" /></span>
                        <span>Every set point passes the checks — the score is calculated below.</span>
                    </div>
                </div>
            ) : lines.length > 0 ? (
                <div className="hs-checks" role="list">
                    {lines.map(l => {
                        const Icon = ICON[l.tone];
                        return (
                            <div key={l.key} role="listitem" className={`hs-chk hs-chk--${l.tone}`} data-testid="check-line" data-tone={l.tone}>
                                <span className="hs-ic"><Icon size={10} strokeWidth={3} aria-hidden="true" /></span>
                                <span>
                                    {l.text}
                                    {l.fix && <span className="hs-fix">{l.fix}</span>}
                                </span>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="hs-note" data-testid="checks-pending">Checking the set points…</div>
            )}
        </section>
    );
}
