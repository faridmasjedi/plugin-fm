import { useEffect, useState } from 'react';
import {
  folderBytes,
  packageXml,
  projectMetadataZip,
  neededToo,
  piecesZip,
  rolesToo,
  schemaPlan,
  type AddedPiece,
  type AccessFile,
  type SalesforceClient,
  type SchemaNeed,
  type SchemaWant,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { useProject } from '../project';
import { download } from './DataTable';
import { ReleasePanel } from './ReleasePanel';
import { Select } from './Select';

type Component = { type: string; name: string };
const keyOf = (c: Component) => `${c.type}:${c.name}`;
const NONE: Array<{ name: string }> = [];
const KIND: Record<string, string> = {
  CustomObject: 'Object',
  CustomField: 'Field',
  ApexClass: 'Apex class',
  Role: 'Role',
  Group: 'Public group or queue',
};

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
  extra = NONE,
  forWhat = 'these permission sets',
}: {
  /** The org the users and permission sets go into. */
  target: { id: string; label: string; client: SalesforceClient };
  /** The permission sets and groups that will be made there. */
  files: AccessFile[];
  /** After a deploy: check again. */
  onChanged?: () => void;
  /** Other needs, each named (the settings and jobs to put back after a refresh). */
  extra?: Array<{ name: string } & SchemaWant>;
  /** What the pieces are for, in the heading ("these permission sets", "these settings"). */
  forWhat?: string;
}) {
  const studio = useStudio();
  const project = useProject();
  const [plan, setPlan] = useState<{ needs: SchemaNeed[]; components: Component[] } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState<string>('');
  const [checks, setChecks] = useState(0);
  // What those pieces use in the org they come from, that the target lacks too (null: still reading)
  const [also, setAlso] = useState<AddedPiece[] | null>([]);
  // A deploy from here went through: once nothing is missing, it says so instead of disappearing
  const [deployed, setDeployed] = useState(false);
  const others = studio.orgs.filter((o) => o.id !== target.id);

  useEffect(() => {
    let canceled = false;
    setPlan(null);
    if (!files.length && !extra.length) return;
    void schemaPlan(target.client, files, extra)
      .then((p) => {
        if (canceled) return;
        setPlan(p);
        setTicked(new Set(p.components.map(keyOf)));
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [target.client, files, extra, checks]);
  // Where the components come from: the org the users came from when it is connected, else the project
  useEffect(() => {
    if (from) return;
    setFrom(project.source ? 'project' : others[0]?.id ?? '');
  }, [from, project.source, others]);

  // From an org: follow what each piece uses there (a class using another class, an object…)
  useEffect(() => {
    setAlso([]);
    if (!plan?.components.length || !from || from === 'project') return undefined;
    let canceled = false;
    setAlso(null);
    void studio
      .clientFor(from)
      .then(async (source) => [
        ...(await rolesToo(
          source,
          target.client,
          plan.components.filter((c) => c.type === 'Role').map((c) => c.name)
        )),
        ...(await neededToo(source, target.client, plan.components)),
      ])
      .then((found) => {
        if (canceled) return;
        setAlso(found);
        setTicked((now) => new Set([...now, ...found.map(keyOf)]));
      })
      .catch(() => !canceled && setAlso([]));
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, from]);

  if (!plan || !plan.components.length)
    return deployed && plan ? (
      <p className="good">
        ✓ Deployed: {target.label} has everything {forWhat} need.
      </p>
    ) : null;
  const chosen = [...plan.components, ...(also ?? [])].filter((c) => ticked.has(keyOf(c)));
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
  const sourceLabel = (id: string) => (id === 'project' ? 'the project' : others.find((o) => o.id === id)?.label ?? '');
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
    return { zip: await piecesZip(source, chosen) };
  };

  return (
    <div className="note warn-box schema-gaps">
      <b>
        {target.label} lacks what {forWhat} need. Deploy it first, then they go in whole (otherwise what needs it fails
        or is left out):
      </b>
      <ol className="schema-steps">
        {plan.needs.map((n) => (
          <li key={`${n.type}:${n.name}`}>
            <span className="muted">
              {n.type === 'PermissionSet' ? 'Permission set' : n.type === 'Settings' ? '' : 'Permission set group'}
            </span>{' '}
            <b>{n.name}</b> needs:
            <div className="schema-needs">
              {plan.components
                .filter(
                  (c) =>
                    (c.type === 'CustomObject' && n.objects.includes(c.name)) ||
                    (c.type === 'CustomField' && n.fields.includes(c.name)) ||
                    (c.type === 'ApexClass' && n.classes.includes(c.name)) ||
                    (c.type === 'Role' && n.roles.includes(c.name)) ||
                    (c.type === 'Group' && n.groups.includes(c.name))
                )
                .map(tickbox)}
            </div>
          </li>
        ))}
      </ol>
      {also === null && <p className="muted small">Reading what they use in {sourceLabel(from)}…</p>}
      {also && also.length > 0 && (
        <div className="schema-also">
          <b>Also needed, because they use them</b> (found in {sourceLabel(from)}):
          <div className="schema-needs">
            {also.map((c) => (
              <span key={keyOf(c)}>
                {tickbox(c)} <span className="muted small">← {c.neededBy}</span>
              </span>
            ))}
          </div>
        </div>
      )}
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
              setDeployed(true);
              setChecks((n) => n + 1);
              onChanged?.();
            }
          }}
        />
      )}
    </div>
  );
}
