import { TriangleAlert } from 'lucide-react';
import type { WorkspaceMetadata } from '../../types';
import { mono, type Tokens } from './uploadTheme';
import { Card, Eyebrow } from './SetupPrimitives';
import RecentProjectCard from './RecentProjectCard';
import { PROJECT_NAME_MAX, isDuplicateProjectName } from './setupHelpers';

interface ProjectNameStepProps {
  T: Tokens;
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  /** Existing projects -- only used for the non-blocking "name already exists" warning. */
  existing: WorkspaceMetadata[];
}

const NEXT_ITEMS: { mark: string; bold: string; rest: string }[] = [
  { mark: '02', bold: 'Add sensor CSVs', rest: ' — first column must be the timestamp' },
  { mark: '+', bold: 'Tag-name file', rest: ' (optional) adds names, units, components and alarm limits' },
  { mark: '03', bold: 'Open the Dashboard', rest: ' and start exploring' },
];

/** Step 1 of the Import page: "Name your project". */
export default function ProjectNameStep({
  T, name, onNameChange, description, onDescriptionChange, existing,
}: ProjectNameStepProps) {
  const duplicate = isDuplicateProjectName(name, existing);
  const label = { fontSize: 12.5, fontWeight: 600, color: T.text, marginBottom: 7, display: 'flex', alignItems: 'baseline', gap: 8 } as const;
  const field = {
    width: '100%', boxSizing: 'border-box', background: T.bg, border: `1px solid ${T.borderStrong}`,
    borderRadius: 10, color: T.text, fontFamily: 'inherit', outline: 'none',
  } as const;

  return (
    <div data-testid="project-name-step">
      <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.textFaint }}>
        Step 1 of 2
      </div>
      <h2 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 700, letterSpacing: '-0.025em', color: T.text }}>
        Name your project
      </h2>
      <p style={{ margin: '8px 0 0', maxWidth: '70ch', fontSize: 13.5, lineHeight: 1.5, color: T.textMuted }}>
        The project keeps your data, sensor names, failure groups and models together. You can rename it later.
      </p>

      <div style={{
        marginTop: 26, display: 'grid', gap: 22, alignItems: 'start',
        gridTemplateColumns: 'minmax(0, 560px) minmax(240px, 360px)',
      }}>
        <Card T={T} style={{ padding: 20 }}>
          <label htmlFor="project-name-input" style={label}>
            Project name{' '}
            <small style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, color: T.warn }}>required</small>
            <span data-testid="name-counter" style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 11, fontWeight: 400, color: T.textFaint }}>
              {name.length}/{PROJECT_NAME_MAX}
            </span>
          </label>
          <input
            id="project-name-input"
            autoFocus
            autoComplete="off"
            maxLength={PROJECT_NAME_MAX}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. Compressor Line 3 — Q3 Baseline"
            style={{ ...field, padding: '13px 14px', fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}
          />
          {duplicate ? (
            <div role="status" style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: T.warn }}>
              <TriangleAlert size={12} style={{ flexShrink: 0 }} />
              A project with this name already exists — you can still use it.
            </div>
          ) : (
            <div style={{ marginTop: 7, fontSize: 11.5, color: T.textFaint }}>
              Tip: unit + topic, like “GT-11 compressor fouling”.
            </div>
          )}

          <div style={{ height: 18 }} />

          <label htmlFor="project-description-input" style={label}>
            Description{' '}
            <small style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 500, color: T.textFaint }}>optional</small>
          </label>
          <textarea
            id="project-description-input"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="What is this workspace for?"
            rows={4}
            style={{ ...field, padding: '11px 13px', fontSize: 13.5, lineHeight: 1.5, minHeight: 96, resize: 'vertical' }}
          />
        </Card>

        <div>
          <Card T={T} style={{ padding: 16 }}>
            <Eyebrow T={T} style={{ marginBottom: 10 }}>Shows in recent projects as</Eyebrow>
            <RecentProjectCard
              T={T}
              preview
              project={{ id: '', name, description, lastModified: 0 }}
            />
          </Card>
          <Card T={T} style={{ padding: 16, marginTop: 14 }}>
            <Eyebrow T={T} style={{ marginBottom: 10 }}>Next</Eyebrow>
            <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {NEXT_ITEMS.map((it) => (
                <li key={it.mark} style={{ display: 'flex', gap: 10, fontSize: 12.5, color: T.textMuted }}>
                  <i
                    aria-hidden="true"
                    style={{
                      width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center',
                      fontFamily: mono, fontStyle: 'normal', fontSize: 10.5, fontWeight: 600,
                      background: T.surfaceHi, color: T.textMuted,
                    }}
                  >
                    {it.mark}
                  </i>
                  <span><b style={{ color: T.text, fontWeight: 600 }}>{it.bold}</b>{it.rest}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
