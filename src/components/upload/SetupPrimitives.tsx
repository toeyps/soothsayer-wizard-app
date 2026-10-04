import type { CSSProperties, ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { mono, type Tokens } from './uploadTheme';

/** Small presentational pieces shared by the setup steps (1 and 2) of the Import page. */

export function Card({ T, children, style = {} }: { T: Tokens; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, ...style }}>
      {children}
    </div>
  );
}

export function Pill({
  T, children, tone = 'neutral',
}: { T: Tokens; children: ReactNode; tone?: 'neutral' | 'info' | 'ok' | 'warn' }) {
  const tones: Record<string, { bg: string; fg: string; bd: string }> = {
    neutral: { bg: T.chipBg, fg: T.textMuted, bd: T.border },
    info: { bg: T.accentMuted, fg: T.accentHi, bd: 'transparent' },
    ok: { bg: 'oklch(0.7 0.15 150 / 0.12)', fg: T.ok, bd: 'transparent' },
    warn: { bg: 'oklch(0.75 0.14 75 / 0.14)', fg: T.warn, bd: 'transparent' },
  };
  const t = tones[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 9px', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
      color: t.fg, background: t.bg, border: `1px solid ${t.bd}`,
      borderRadius: 99, fontFamily: 'inherit',
    }}>{children}</span>
  );
}

/** Icon tile + title + monospace subtitle (+ optional right-aligned tag) at the top of a card. */
export function SectionHeader({
  T, icon, iconBg, iconColor, title, subtitle, tag,
}: {
  T: Tokens; icon: ReactNode; iconBg: string; iconColor: string;
  title: string; subtitle: string; tag?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${T.border}` }}>
      <div style={{
        width: 30, height: 30, borderRadius: 9, background: iconBg, color: iconColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text, letterSpacing: '-0.005em' }}>{title}</div>
        <div style={{ fontSize: 11, color: T.textFaint, marginTop: 1, fontFamily: mono }}>{subtitle}</div>
      </div>
      {tag ?? null}
    </div>
  );
}

/** Small uppercase monospace caption used above a block ("Components", "Next", ...). */
export function Eyebrow({ T, children, style = {} }: { T: Tokens; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 500, color: T.textFaint, letterSpacing: '0.1em',
      textTransform: 'uppercase', fontFamily: mono, ...style,
    }}>
      {children}
    </div>
  );
}

/** The footer's primary action ("Continue" on step 1, "Open Dashboard" on step 2). */
export function PrimaryButton({
  T, enabled, onClick, children,
}: { T: Tokens; enabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '9px 16px', fontSize: 13, fontWeight: 600, color: '#fff',
        background: enabled ? T.accent : T.surfaceHi,
        border: `1px solid ${enabled ? T.accent : T.border}`,
        borderRadius: 8, cursor: enabled ? 'pointer' : 'not-allowed',
        fontFamily: 'inherit', letterSpacing: '-0.005em',
        opacity: enabled ? 1 : 0.6,
        boxShadow: enabled ? `0 1px 0 0 rgba(255,255,255,0.15) inset, 0 4px 14px ${T.accentMuted}` : 'none',
      }}
    >
      {children}
      <ArrowRight size={13} />
    </button>
  );
}

export function BackButton({ T, onClick }: { T: Tokens; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '9px 14px', fontSize: 13, fontWeight: 500, color: T.textMuted,
        background: 'none', border: `1px solid ${T.border}`,
        borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      ‹ Back
    </button>
  );
}
