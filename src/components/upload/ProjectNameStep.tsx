import type { MachineDetails, WorkspaceMetadata } from '../../types';
import { isDuplicatePlantMachine, projectDescription, projectDisplayName } from '../../utils/projectDetails';
import { mono, type Tokens } from './uploadTheme';
import { Card, Eyebrow } from './SetupPrimitives';
import RecentProjectCard from './RecentProjectCard';
import { MachineFields } from './MachineFields';

interface ProjectNameStepProps {
  T: Tokens;
  machine: MachineDetails;
  onMachineChange: (m: MachineDetails) => void;
  /** Existing projects -- a Plant · Machine pair one of them already uses blocks Continue. */
  existing: WorkspaceMetadata[];
}

const NEXT_ITEMS: { mark: string; bold: string; rest: string }[] = [
  { mark: '02', bold: 'Add sensor CSVs', rest: ' — first column must be the timestamp' },
  { mark: '+', bold: 'Tag-name file', rest: ' (optional) adds names, units, components and alarm limits' },
  { mark: '03', bold: 'Name the failure groups', rest: ' — the ways this machine can fail (optional)' },
  { mark: '04', bold: 'Open the Dashboard', rest: ' and assign sensors to each group' },
];

/** Step 1 of the Import page: "Which machine is this?". The project is named
 *  "Plant · Machine"; its description is "tag · notes". */
export default function ProjectNameStep({ T, machine, onMachineChange, existing }: ProjectNameStepProps) {
  const duplicate = isDuplicatePlantMachine(machine, existing);
  const name = projectDisplayName(machine);
  const description = projectDescription(machine);

  return (
    <div data-testid="project-name-step">
      <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.textFaint }}>
        Step 1 of 3
      </div>
      <h2 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 700, letterSpacing: '-0.025em', color: T.text }}>
        Which machine is this?
      </h2>
      <p style={{ margin: '8px 0 0', maxWidth: '70ch', fontSize: 13.5, lineHeight: 1.5, color: T.textMuted }}>
        One project is one machine. It is named after the plant and the machine — <b style={{ color: T.text, fontWeight: 600 }}>Plant · Machine</b> — and keeps your data, sensor names, failure groups and models together. You can change these later under Project details.
      </p>

      <div style={{
        marginTop: 26, display: 'grid', gap: 22, alignItems: 'start',
        gridTemplateColumns: 'minmax(0, 560px) minmax(240px, 360px)',
      }}>
        <Card T={T} style={{ padding: 20 }}>
          <Eyebrow T={T} style={{ marginBottom: 12 }}>Plant and machine</Eyebrow>
          <MachineFields value={machine} onChange={onMachineChange} autoFocus large duplicate={duplicate} />
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
