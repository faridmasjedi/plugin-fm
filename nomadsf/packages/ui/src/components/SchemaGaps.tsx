import { useEffect, useState } from 'react';
import {
  buildDiffPackage,
  folderBytes,
  fromBase64,
  packageXml,
  projectMetadataZip,
  schemaPlan,
  type AccessFile,
  type SalesforceClient,
  type SchemaNeed,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { useProject } from '../project';
import { download } from './DataTable';
import { ReleasePanel } from './ReleasePanel';
import { Select } from './Select';

type Component = { type: string; name: string };
const keyOf = (c: Component) => `${c.type}:${c.name}`;
const KIND: Record<string, string> = { CustomObject: 'Object', CustomField: 'Field', ApexClass: 'Apex class' };

/**
 * What an org needs before permission sets and groups can be made there with all their access: per permission set,
 * the objects (with their fields), fields and Apex classes it lacks — in the order to deploy them. Tick what to deploy,
 * take it from another org or from the project, validate or deploy it here, then the permission sets go in whole.
 * A package.xml of it can be downloaded too, to deploy another way.
 */
export function SchemaGaps({
  target,
  files,
  onChanged,
}: {
  /** The org the users and permission sets go into. */
  target: { id: string; label: string; client: SalesforceClient };
  /** The permission sets and groups that will be made there. */
  files: AccessFile[];
  /** After a deploy: check again. */
  onChanged?: () => void;
}) {
  const studio = useStudio();
  const project = useProject();
  const [plan, setPlan] = useState<{ needs: SchemaNeed[]; components: Component[] } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState<string>('');
  const [checks, setChecks] = useState(0);
  const others = studio.orgs.filter((o) => o.id !== target.id);

  useEffect(() => {
    let canceled = false;
    setPlan(null);
    if (!files.length) return;
    void schemaPlan(target.client, files)
      .then((p) => {
        if (canceled) return;
        setPlan(p);
        setTicked(new Set(p.components.map(keyOf)));
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [target.client, files, checks]);
  // Where the components come from: the org the users came from when it is connected, else the project
  useEffect(() => {
    if (from) return;
    setFrom(project.source ? 'project' : others[0]?.id ?? '');
  }, [from, project.source, others]);

  if (!plan || !plan.components.length) return null;
  const chosen = plan.components.filter((c) => ticked.has(keyOf(c)));
  const flip = (k: string) => {
    const next = new Set(ticked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setTicked(next);
  };
  const tickbox = (c: Component) => (
    <label className="check" key={keyOf(c)}>
      <input type="checkbox" checked={ticked.has(keyOf(c))} onChange={() => flip(keyOf(c))} /> {KIND[c.type]}{' '}
      <span className="mono">{c.name}</span>
      {c.type === 'CustomObject' && <span className="muted"> (with its fields)</span>}
    </label>
  );
  const sourceOrg = others.find((o) => o.id === from);
  const build = async () => {
    if (from === 'project') {
      if (!project.source || !project.info) throw new Error('Open the project first (Settings › Project).');
      const handle = project.source.handle;
      const r = await projectMetadataZip({
        fs: project.source.fs,
        info: project.info,
        readBytes: handle ? (path) => folderBytes(handle, path) : undefined,
        deploy: chosen,
        apiVersion: await target.client.version(),
      });
      return { zip: r.zip, notConverted: r.notConverted };
    }
    if (!sourceOrg) throw new Error('Choose where they come from.');
    const source = await studio.clientFor(sourceOrg.id);
    const pkg = await buildDiffPackage(source, chosen);
    return { zip: fromBase64(pkg.zipBase64) };
  };

  return (
    <div className="note warn-box schema-gaps">
      <b>
        {target.label} lacks what these permission sets need. Deploy it first, then the permission sets go in with all
        their access (otherwise those entries are left out):
      </b>
      <ol className="schema-steps">
        {plan.needs.map((n) => (
          <li key={`${n.type}:${n.name}`}>
            <span className="muted">{n.type === 'PermissionSet' ? 'Permission set' : 'Permission set group'}</span>{' '}
            <b>{n.name}</b> needs:
            <div className="schema-needs">
              {plan.components
                .filter(
                  (c) =>
                    (c.type === 'CustomObject' && n.objects.includes(c.name)) ||
                    (c.type === 'CustomField' && n.fields.includes(c.name)) ||
                    (c.type === 'ApexClass' && n.classes.includes(c.name))
                )
                .map(tickbox)}
            </div>
          </li>
        ))}
      </ol>
      <div className="form">
        <label>
          Take them from
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {project.source && <option value="project">The project ({project.info?.name ?? 'open'})</option>}
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                Org {o.label}
              </option>
            ))}
          </Select>
        </label>
        <button
          disabled={!chosen.length}
          onClick={() =>
            download(
              `needed-by-permission-sets.package.xml`,
              packageXml(
                chosen.map((c) => ({ type: c.type, fullName: c.name })),
                '62.0'
              ),
              'text/xml'
            )
          }
        >
          Download package.xml
        </button>
        <button onClick={() => setChecks((n) => n + 1)}>Check again</button>
      </div>
      {chosen.length > 0 && from && (
        <ReleasePanel
          key={`${from}|${chosen.map(keyOf).join(',')}`}
          deployCount={chosen.length}
          removeCount={0}
          from={from === 'project' ? 'the project' : sourceOrg?.label ?? ''}
          build={build}
          targetId={target.id}
          zipName={`needed-by-permission-sets.zip`}
          onDone={(outcome) => {
            if (outcome.success && !outcome.checkOnly) {
              setChecks((n) => n + 1);
              onChanged?.();
            }
          }}
        />
      )}
    </div>
  );
}
