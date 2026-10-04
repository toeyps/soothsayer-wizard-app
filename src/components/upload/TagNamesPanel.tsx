import { useMemo, useState } from 'react';
import { Download, Info, Search, Tag, X } from 'lucide-react';
import type { UseMappingDataReturn } from '../../hooks/useMappingData';
import type { SensorMetadata } from '../../types';
import { mono, type Tokens } from './uploadTheme';
import { Card, Eyebrow, SectionHeader } from './SetupPrimitives';
import { ALARM_KEYS, ALARM_LABELS, alarmLimits, baseName, countComponents, matchedFraction } from './setupHelpers';

interface TagNamesPanelProps {
  T: Tokens;
  /** The dataset has not been read yet (or the file selection changed since): the panel is greyed out. */
  locked: boolean;
  mapping: UseMappingDataReturn;
}

type Tab = 'matched' | 'noname';

/** Most rows rendered in the tag table at once (search narrows the rest). */
const MAX_ROWS = 200;

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

/** Four dots LL / L / H / HH, lit when that limit exists. The tooltip lists the values. */
function AlarmDots({ T, sensor }: { T: Tokens; sensor: SensorMetadata }) {
  const present = alarmLimits(sensor);
  const label = present.length ? present.map((a) => `${a.label} ${a.value}`).join(' · ') : 'No alarm limits';
  return (
    <span title={label} aria-label={label} style={{ display: 'inline-flex', gap: 3 }}>
      {ALARM_KEYS.map((k) => {
        const on = typeof sensor[k] === 'number' && Number.isFinite(sensor[k] as number);
        const hot = k === 'alarmLL' || k === 'alarmHH';
        return (
          <i
            key={k}
            data-alarm={ALARM_LABELS[k]}
            data-on={on ? 'true' : 'false'}
            style={{ width: 6, height: 6, borderRadius: '50%', background: on ? (hot ? T.danger : T.warn) : T.surfaceHi }}
          />
        );
      })}
    </span>
  );
}

/** Step 2, right column: "Tag names" (the optional tag -> name / unit / component / alarm-limit lookup). */
export default function TagNamesPanel({ T, locked, mapping }: TagNamesPanelProps) {
  const [tab, setTab] = useState<Tab>('matched');
  const [query, setQuery] = useState('');
  const result = mapping.mappingResult;

  const matchedCount = result?.matched.length ?? 0;
  const noNameTags = result?.not_in_mapping ?? [];
  const totalSensors = matchedCount + noNameTags.length;
  const fraction = matchedFraction(matchedCount, totalSensors);
  const allMatched = noNameTags.length === 0;

  const components = useMemo(() => countComponents(mapping.sensorMetadata), [mapping.sensorMetadata]);

  const matchedRows: SensorMetadata[] = useMemo(() => {
    if (!result) return [];
    if (mapping.sensorMetadata && mapping.sensorMetadata.length > 0) return mapping.sensorMetadata;
    return result.matched.map((tag) => ({ tag, description: '', unit: '', component: '' }));
  }, [result, mapping.sensorMetadata]);

  const q = query.trim().toLowerCase();
  const filteredMatched = q
    ? matchedRows.filter((r) => `${r.tag} ${r.description ?? ''}`.toLowerCase().includes(q))
    : matchedRows;
  const filteredNoName = q ? noNameTags.filter((t) => t.toLowerCase().includes(q)) : noNameTags;

  const showName = matchedRows.some((r) => (r.description ?? '').trim() !== '');
  const showUnit = matchedRows.some((r) => (r.unit ?? '').trim() !== '');
  const showAlarms = matchedRows.some((r) => alarmLimits(r).length > 0);

  const activeTab: Tab = tab === 'noname' && noNameTags.length === 0 ? 'matched' : tab;
  const shown = activeTab === 'matched' ? filteredMatched : filteredNoName;
  const total = shown.length;

  const td = { padding: '7px 4px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle' } as const;

  return (
    <Card T={T} style={{ padding: 0, minWidth: 0, opacity: locked ? 0.6 : 1 }}>
      <SectionHeader
        T={T}
        icon={<Tag size={15} />}
        iconBg="oklch(0.7 0.15 310 / 0.18)"
        iconColor={T.s4}
        title="Tag names"
        subtitle="optional · tag → name, unit, component, alarms"
      />

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {locked ? (
          <div
            data-testid="tag-names-locked"
            style={{
              padding: 20, textAlign: 'center', border: `1px dashed ${T.borderStrong}`, borderRadius: 12,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: T.textFaint,
            }}
          >
            <Info size={15} />
            <b style={{ fontSize: 12.5, fontWeight: 600, color: T.textMuted }}>Add sensor data first</b>
            <span style={{ fontSize: 12 }}>
              Tag names are matched against the columns in your CSV files — available once the files have been read.
            </span>
          </div>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: T.textMuted }}>
              Replace cryptic tags like{' '}
              <span style={{ fontFamily: mono, fontSize: 11, color: T.text, background: T.surfaceHi, padding: '1px 5px', borderRadius: 4 }}>
                850P402.PV
              </span>{' '}
              with human-readable sensor names, group sensors by component and show alarm limits on charts.
            </p>

            {mapping.mappingFilePath ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px 8px 10px',
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10,
              }}>
                <span style={{
                  width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0,
                  background: 'oklch(0.62 0.14 300 / 0.16)', color: T.s4, fontFamily: mono, fontSize: 8.5, fontWeight: 700,
                }}>CSV</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 500, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {baseName(mapping.mappingFilePath)}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 10.5, color: T.textFaint, marginTop: 1 }}>
                    {mapping.mappingData
                      ? `${mapping.mappingData.rows.length} rows${result ? ` · ${result.matched.length} matched` : ''}`
                      : 'loading…'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={mapping.clearMapping}
                  aria-label="Remove tag-name file"
                  title="Remove"
                  style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', border: 'none', background: 'none', color: T.textFaint, cursor: 'pointer', borderRadius: 7 }}
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={mapping.selectMappingFile}
                  disabled={mapping.isLoading}
                  style={{
                    width: '100%', minHeight: 150, padding: 16, cursor: 'pointer', fontFamily: 'inherit', color: T.text,
                    border: `1.5px dashed ${T.borderStrong}`, borderRadius: 14,
                    background: 'radial-gradient(ellipse at 50% 0%, oklch(0.62 0.14 300 / 0.1), transparent 70%)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center',
                  }}
                >
                  <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'oklch(0.62 0.14 300 / 0.16)', color: T.s4 }}>
                    <Download size={18} />
                  </span>
                  <b style={{ fontSize: 13 }}>Select tag-name CSV</b>
                  <span style={{ fontSize: 11.5, color: T.textMuted, maxWidth: 260 }}>
                    One row per sensor: a tag column, plus optional description, unit, component and alarm_ll / alarm_l / alarm_h / alarm_hh.
                  </span>
                </button>
                <div style={{ fontSize: 11.5, color: T.textFaint }}>
                  Optional — you can open the Dashboard without it.
                </div>
              </>
            )}

            {mapping.mappingData && !mapping.keyColumn && (
              <div style={{ padding: 10, background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Eyebrow T={T} style={{ fontSize: 10 }}>Pick tag column</Eyebrow>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {mapping.mappingData.headers.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => mapping.setKeyColumn(h)}
                      style={{
                        padding: '3px 8px', fontSize: 11, fontFamily: mono, color: T.text, cursor: 'pointer',
                        background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4,
                      }}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mapping.error && (
              <div style={{
                padding: '8px 10px', borderRadius: 7, fontSize: 11.5, color: T.danger,
                background: 'oklch(0.68 0.2 25 / 0.1)', border: '1px solid oklch(0.68 0.2 25 / 0.3)',
              }}>
                {mapping.error}
              </div>
            )}

            {result && (
              <>
                <div
                  data-testid="match-summary"
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 12, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 12 }}
                >
                  {fraction !== null && (
                    <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true" data-testid="match-ring" style={{ flexShrink: 0 }}>
                      <circle cx="27" cy="27" r={RING_R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
                      <circle
                        cx="27" cy="27" r={RING_R} fill="none" strokeWidth="6" strokeLinecap="round"
                        stroke={allMatched ? T.ok : T.warn}
                        strokeDasharray={`${RING_C * fraction} ${RING_C}`}
                        transform="rotate(-90 27 27)"
                      />
                    </svg>
                  )}
                  <div>
                    <b data-testid="match-count" style={{ fontFamily: mono, fontSize: 18, fontWeight: 600, color: T.text }}>
                      {totalSensors > 0 ? `${matchedCount} / ${totalSensors}` : `${matchedCount}`}
                    </b>
                    <span style={{ display: 'block', fontSize: 12, color: T.textMuted }}>
                      {totalSensors === 0
                        ? 'names matched'
                        : allMatched
                          ? 'every column has a name'
                          : `${noNameTags.length} column${noNameTags.length === 1 ? ' has' : 's have'} no name yet`}
                    </span>
                  </div>
                </div>

                {components.length > 0 && (
                  <div>
                    <Eyebrow T={T} style={{ marginBottom: 6 }}>Components</Eyebrow>
                    <div data-testid="component-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {components.map((c) => (
                        <span key={c.name} style={{
                          fontSize: 11, color: T.textMuted, padding: '1px 8px',
                          border: `1px solid ${T.borderStrong}`, borderRadius: 99,
                        }}>
                          {c.name}
                          <b style={{ marginLeft: 4, fontFamily: mono, fontSize: 10.5, fontWeight: 600, color: T.text }}>{c.count}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderBottom: `1px solid ${T.border}` }}>
                    <div role="tablist" style={{ display: 'flex', gap: 4 }}>
                      {([
                        { id: 'matched' as const, label: 'Matched', n: matchedCount },
                        ...(noNameTags.length > 0 ? [{ id: 'noname' as const, label: 'No name', n: noNameTags.length }] : []),
                      ]).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="tab"
                          aria-selected={activeTab === t.id}
                          onClick={() => setTab(t.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 8px', fontSize: 12, fontFamily: 'inherit',
                            color: activeTab === t.id ? T.text : T.textMuted, cursor: 'pointer', background: 'none', border: 'none',
                            borderBottom: `2px solid ${activeTab === t.id ? T.s4 : 'transparent'}`,
                          }}
                        >
                          {t.label}
                          <em style={{ fontFamily: mono, fontSize: 10.5, fontStyle: 'normal', color: T.textFaint }}>{t.n}</em>
                        </button>
                      ))}
                    </div>
                    <span style={{ flex: 1 }} />
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: 6, height: 26, width: 150, padding: '0 8px', margin: '2px 0',
                      border: `1px solid ${T.borderStrong}`, borderRadius: 8, color: T.textFaint,
                    }}>
                      <Search size={12} style={{ flexShrink: 0 }} />
                      <input
                        aria-label="Find tag"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Find tag"
                        style={{ width: '100%', background: 'none', border: 0, outline: 'none', fontSize: 12, color: T.text, fontFamily: 'inherit' }}
                      />
                    </label>
                  </div>

                  <div style={{ maxHeight: 250, overflow: 'auto' }}>
                    <table data-testid="tag-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <tbody>
                        {activeTab === 'matched'
                          ? filteredMatched.slice(0, MAX_ROWS).map((r) => (
                            <tr key={r.tag}>
                              <td style={{ ...td, fontFamily: mono, fontSize: 11, color: T.textFaint, whiteSpace: 'nowrap' }}>{r.tag}</td>
                              {showName && (
                                <td style={{ ...td, width: '100%', maxWidth: 0, fontWeight: 500, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {r.description}
                                </td>
                              )}
                              {showUnit && <td style={{ ...td, fontFamily: mono, fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' }}>{r.unit}</td>}
                              {showAlarms && <td style={td}><AlarmDots T={T} sensor={r} /></td>}
                            </tr>
                          ))
                          : filteredNoName.slice(0, MAX_ROWS).map((tag) => (
                            <tr key={tag}>
                              <td style={{ ...td, fontFamily: mono, fontSize: 11, color: T.textFaint, whiteSpace: 'nowrap' }}>{tag}</td>
                              <td style={{ ...td, width: '100%', color: T.textFaint }}>no name — tag code is shown</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {total === 0 && (
                      <div style={{ padding: '10px 4px', fontSize: 12, color: T.textFaint }}>No tags match “{query}”.</div>
                    )}
                    {total > MAX_ROWS && (
                      <div style={{ padding: '8px 4px', fontSize: 11.5, color: T.textFaint }}>
                        Showing the first {MAX_ROWS} of {total} — use search to find the rest.
                      </div>
                    )}
                  </div>
                </div>

                {result.not_in_dataset.length > 0 && (
                  <div
                    data-testid="not-in-dataset"
                    title={result.not_in_dataset.slice(0, 20).join(', ')}
                    style={{ fontSize: 11.5, color: T.warn }}
                  >
                    {result.not_in_dataset.length} tag{result.not_in_dataset.length === 1 ? '' : 's'} in the tag-name file
                    {result.not_in_dataset.length === 1 ? ' is' : ' are'} not in the dataset.
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
