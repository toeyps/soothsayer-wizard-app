import type { CsvFileInfo } from '../../types/dataUpload';
import { mono, type Tokens } from './uploadTheme';
import { computeCoverage } from './setupHelpers';

const LANE_COLORS = (T: Tokens) => [T.s1, T.s2, T.s3, T.s4];

/**
 * "Time coverage": one bar per file on a SHARED time axis, so overlapping files
 * are visible at a glance. Renders nothing when no file has a readable time
 * range (the geometry helper returns null).
 */
export default function TimeCoverage({ T, files }: { T: Tokens; files: CsvFileInfo[] | null | undefined }) {
  const coverage = computeCoverage(files);
  if (!coverage) return null;
  const colors = LANE_COLORS(T);
  const multi = (files?.length ?? 0) > 1;
  const note = !multi
    ? 'one file'
    : coverage.overlaps
      ? 'files overlap — merged on their timestamps'
      : 'files do not overlap';

  return (
    <div
      data-testid="time-coverage"
      style={{ border: `1px solid ${T.border}`, borderRadius: 11, padding: 12, background: T.bg }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, fontWeight: 600, color: T.text }}>
        Time coverage
        <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 400, color: T.textFaint }}>{note}</span>
      </div>

      {coverage.lanes.map((lane, i) => (
        <div
          key={lane.index}
          data-testid="coverage-lane"
          style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 10, alignItems: 'center', marginTop: 6, fontFamily: mono, fontSize: 11, color: T.textMuted }}
        >
          <span title={lane.name} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
          <div style={{ position: 'relative', height: 10, borderRadius: 4, background: T.surfaceHi }}>
            <i
              data-testid="coverage-bar"
              title={lane.start && lane.end ? `${lane.start} → ${lane.end}` : undefined}
              style={{
                position: 'absolute', top: 0, bottom: 0, borderRadius: 4,
                left: `${lane.leftPct}%`, width: `${lane.widthPct}%`,
                background: colors[i % colors.length], opacity: 0.85,
              }}
            />
          </div>
        </div>
      ))}

      <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 10, marginTop: 6 }}>
        <span />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontSize: 10, color: T.textFaint }}>
          {coverage.ticks.map((t) => <span key={t.pct}>{t.label}</span>)}
        </div>
      </div>

      {coverage.hiddenCount > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: T.textFaint }}>
          {coverage.hiddenCount} file{coverage.hiddenCount === 1 ? '' : 's'} without a readable time range
          {coverage.hiddenCount === 1 ? ' is' : ' are'} not shown.
        </div>
      )}
    </div>
  );
}
