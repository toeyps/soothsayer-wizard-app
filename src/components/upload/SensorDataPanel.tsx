import { Activity, AlertTriangle, Check, Download, Loader2, Plus, X } from 'lucide-react';
import type { CsvLoadProgress, CsvLoadReport } from '../../types/dataUpload';
import { mono, type Tokens } from './uploadTheme';
import { Card, Pill, SectionHeader } from './SetupPrimitives';
import TimeCoverage from './TimeCoverage';
import {
  baseName,
  fileReadState,
  findFileInfo,
  formatCount,
  formatFileSize,
  progressStageLabel,
  summarizeReport,
} from './setupHelpers';

interface SensorDataPanelProps {
  T: Tokens;
  /** Selected file paths, in selection order. */
  files: string[];
  report: CsvLoadReport | null;
  /** A parse exists and the selection still matches it. */
  isReady: boolean;
  /** A parse exists but the selection changed since. */
  isStale: boolean;
  /** THIS page's own parse (Parse files) is running. */
  isLoading: boolean;
  error: string | null;
  /** Latest `csv-load-progress` of this page's own parse (null otherwise). */
  progress: CsvLoadProgress | null;
  onBrowse: () => void;
  onRemove: (path: string) => void;
  onParse: () => void;
}

const REQUIREMENTS = ['First column is date/time', 'Unique column names', 'Up to 2 GB per file'];

function Kpi({
  T, label, value, sub, wide = false, small = false,
}: { T: Tokens; label: string; value: string; sub?: string | null; wide?: boolean; small?: boolean }) {
  return (
    <div
      data-testid="summary-card"
      style={{
        gridColumn: wide ? 'span 2' : undefined, minWidth: 0,
        border: `1px solid ${T.border}`, borderRadius: 11, padding: '10px 12px', background: T.bg,
      }}
    >
      <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.textFaint }}>
        {label}
      </div>
      <div style={{
        marginTop: 3, fontFamily: mono, fontWeight: 600, letterSpacing: '-0.02em', color: T.text,
        fontSize: small ? 13 : 18, lineHeight: small ? 1.5 : 1.3,
      }}>
        {value}
      </div>
      {sub ? <div style={{ fontSize: 11, color: T.textFaint }}>{sub}</div> : null}
    </div>
  );
}

/** Step 2, left column: "Sensor data" -- dropzone, file rows with read progress, summary, time coverage, fixed-while-reading warnings. */
export default function SensorDataPanel({
  T, files, report, isReady, isStale, isLoading, error, progress, onBrowse, onRemove, onParse,
}: SensorDataPanelProps) {
  const hasFiles = files.length > 0;
  const summary = summarizeReport(report);
  const stage = progressStageLabel(progress);
  const warnings = report?.warnings ?? [];

  const hint = !hasFiles
    ? 'Add at least one CSV file to continue.'
    : isStale
      ? 'File selection changed — click Parse files to re-validate.'
      : 'Click Parse files to validate and continue.';

  return (
    <Card T={T} style={{ padding: 0, minWidth: 0 }}>
      <SectionHeader
        T={T}
        icon={<Activity size={15} />}
        iconBg={T.accentMuted}
        iconColor={T.accentHi}
        title="Sensor data"
        subtitle="CSV · first column = date/time"
        tag={isReady ? <Pill T={T} tone="ok"><Check size={10} /> {files.length} file{files.length === 1 ? '' : 's'} ready</Pill> : undefined}
      />

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!hasFiles && (
          <button
            type="button"
            onClick={onBrowse}
            disabled={isLoading}
            style={{
              width: '100%', minHeight: 300, padding: 20, cursor: isLoading ? 'wait' : 'pointer',
              border: `1.5px dashed ${T.borderStrong}`, borderRadius: 14, color: T.text, fontFamily: 'inherit',
              background: `radial-gradient(ellipse at 50% 0%, ${T.accentMuted}, transparent 70%)`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center',
            }}
          >
            <span style={{
              width: 50, height: 50, borderRadius: 14, display: 'grid', placeItems: 'center',
              background: T.accentMuted, color: T.accentHi,
            }}>
              <Download size={24} />
            </span>
            <b style={{ fontSize: 15 }}>Drop CSV files here</b>
            <span style={{ fontSize: 12.5, color: T.textMuted }}>
              or{' '}
              <span style={{ color: T.accentHi, borderBottom: `1px solid ${T.accentMuted}`, textDecoration: 'underline', textUnderlineOffset: 3 }}>browse</span>
              {' '}your computer — select several to merge them
            </span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 6 }}>
              {REQUIREMENTS.map((r) => (
                <span key={r} style={{
                  fontFamily: mono, fontSize: 10.5, color: T.textFaint, padding: '2px 8px',
                  border: `1px solid ${T.border}`, borderRadius: 99,
                }}>
                  {r}
                </span>
              ))}
            </span>
          </button>
        )}

        {isLoading && (
          <div data-testid="read-status" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: mono, fontSize: 11.5, color: T.textMuted }}>
              <Loader2 size={12} className="animate-spin" style={{ color: T.accentHi }} />
              <span data-testid="read-stage">{stage ?? 'Starting…'}</span>
              {progress && progress.file_count > 0 && (
                <span style={{ color: T.textFaint }}>
                  {Math.min(progress.files_done, progress.file_count)} of {progress.file_count} file{progress.file_count === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div
              role="progressbar"
              aria-label="Reading files"
              aria-valuemin={0}
              aria-valuemax={progress?.file_count ?? files.length}
              aria-valuenow={progress ? Math.min(progress.files_done, progress.file_count) : 0}
              style={{ height: 4, borderRadius: 99, background: T.surfaceHi, overflow: 'hidden' }}
            >
              <i style={{
                display: 'block', height: '100%', borderRadius: 99, background: T.accent, transition: 'width 200ms ease',
                width: progress && progress.file_count > 0 ? `${(Math.min(progress.files_done, progress.file_count) / progress.file_count) * 100}%` : '0%',
              }} />
            </div>
          </div>
        )}

        {hasFiles && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map((path, i) => {
              const name = baseName(path);
              const info = findFileInfo(report, path, i);
              const state = fileReadState(i, progress);
              const rows = formatCount(info?.rows);
              const size = formatFileSize(info?.size_bytes);
              const columns = files.length === 1 && report && Array.isArray(report.columns) && report.columns.length > 0
                ? report.columns.length : null;
              const meta = [rows ? `${rows} rows` : null, columns ? `${columns} columns` : null].filter(Boolean).join(' · ');
              return (
                <div
                  key={path}
                  data-testid="file-row"
                  style={{
                    display: 'grid', gridTemplateColumns: '34px minmax(0, 1fr) auto auto', gap: 12, alignItems: 'center',
                    padding: '10px 10px 10px 12px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 11,
                  }}
                >
                  <span style={{
                    width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center',
                    background: T.accentMuted, color: T.accentHi, fontFamily: mono, fontSize: 9, fontWeight: 700,
                  }}>CSV</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 500, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {name}
                    </div>
                    <div style={{ marginTop: 2, fontFamily: mono, fontSize: 10.5, color: T.textFaint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {path}
                    </div>
                  </div>

                  {isLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        role="progressbar"
                        aria-label={`Reading ${name}`}
                        aria-valuemin={0}
                        aria-valuemax={1}
                        aria-valuenow={state === 'done' ? 1 : state === 'waiting' ? 0 : undefined}
                        data-state={state}
                        style={{ width: 120, height: 4, borderRadius: 99, background: T.surfaceHi, overflow: 'hidden' }}
                      >
                        <i
                          className={state === 'reading' ? 'animate-pulse' : undefined}
                          style={{
                            display: 'block', height: '100%', borderRadius: 99, background: T.accent,
                            width: state === 'waiting' ? '0%' : '100%', opacity: state === 'reading' ? 0.55 : 1,
                          }}
                        />
                      </div>
                      <span style={{ width: 62, fontFamily: mono, fontSize: 11, color: T.textMuted }}>
                        {state === 'done' ? 'Read' : state === 'reading' ? 'Reading…' : 'Waiting'}
                      </span>
                    </div>
                  ) : meta || size ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {meta ? <span style={{ fontFamily: mono, fontSize: 11, color: T.textMuted, textAlign: 'right' }}>{meta}</span> : null}
                      {size ? <span style={{ fontFamily: mono, fontSize: 11, color: T.textFaint }}>{size}</span> : null}
                    </div>
                  ) : <span />}

                  <button
                    type="button"
                    onClick={() => onRemove(path)}
                    aria-label={`Remove ${name}`}
                    title="Remove"
                    style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', border: 'none', background: 'none', color: T.textFaint, cursor: 'pointer', borderRadius: 7 }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 10px', borderRadius: 7, display: 'flex', alignItems: 'center', gap: 8,
            background: 'oklch(0.68 0.2 25 / 0.1)', border: '1px solid oklch(0.68 0.2 25 / 0.3)',
            fontSize: 11.5, color: T.danger,
          }}>
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        )}

        {hasFiles && !isReady && (
          <button
            type="button"
            onClick={onParse}
            disabled={isLoading}
            style={{
              width: '100%', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit', color: '#fff', cursor: isLoading ? 'wait' : 'pointer',
              background: T.accent, border: `1px solid ${T.accent}`, borderRadius: 8, opacity: isLoading ? 0.6 : 1,
            }}
          >
            {isLoading ? <><Loader2 size={14} className="animate-spin" /> Parsing…</> : <>Parse files</>}
          </button>
        )}

        {!isReady && !isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.textMuted }}>
            <AlertTriangle size={13} style={{ color: T.warn, flexShrink: 0 }} />
            <span>{hint}</span>
          </div>
        )}

        {isReady && (
          <>
            <div
              data-testid="summary-grid"
              style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
            >
              {summary.rows !== null && (
                <Kpi T={T} label="Rows" value={summary.rows} sub={files.length > 1 ? 'after merge' : null} />
              )}
              {summary.sensors !== null && (
                <Kpi T={T} label="Sensors" value={summary.sensors} sub="numeric columns" />
              )}
              {summary.periodStart !== null && summary.periodEnd !== null && (
                summary.periodSpan !== null
                  ? <Kpi T={T} label="Period" value={summary.periodSpan} sub={`${summary.periodStart} → ${summary.periodEnd}`} wide />
                  : <Kpi T={T} label="Period" value={`${summary.periodStart} → ${summary.periodEnd}`} wide small />
              )}
              {summary.interval !== null && (
                <Kpi T={T} label="Interval" value={summary.interval} sub="median gap" />
              )}
              {summary.missing !== null && (
                <Kpi T={T} label="% empty" value={summary.missing} sub="of all cells" />
              )}
            </div>

            <TimeCoverage T={T} files={report?.files} />
          </>
        )}

        {/* Non-fatal issues Rust found while reading (duplicate columns,
            duplicate timestamps merged, a Buddhist-Era year corrected to
            Gregorian, ...) -- parsing still succeeded, but the user should know
            before opening the Dashboard. */}
        {warnings.length > 0 && (
          <div
            data-testid="fixed-while-reading"
            style={{
              display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 11, fontSize: 12.5,
              background: 'oklch(0.78 0.14 75 / 0.1)', border: '1px solid oklch(0.78 0.14 75 / 0.3)',
            }}
          >
            <AlertTriangle size={15} style={{ color: T.warn, flexShrink: 0, marginTop: 1 }} />
            <div style={{ minWidth: 0 }}>
              <b style={{ color: T.warn, fontWeight: 600 }}>Fixed while reading</b>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyleType: 'disc', color: T.textMuted, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          </div>
        )}

        {hasFiles && (
          <button
            type="button"
            onClick={onBrowse}
            disabled={isLoading}
            style={{
              width: '100%', padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              border: `1.5px dashed ${T.borderStrong}`, borderRadius: 14, background: 'transparent', color: T.text,
              fontFamily: 'inherit', cursor: isLoading ? 'wait' : 'pointer',
            }}
          >
            <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: T.accentMuted, color: T.accentHi }}>
              <Plus size={15} />
            </span>
            <b style={{ fontSize: 12.5 }}>Add more files</b>
            <span style={{ fontSize: 11.5, color: T.textMuted }}>merged on timestamp</span>
          </button>
        )}
      </div>
    </Card>
  );
}
