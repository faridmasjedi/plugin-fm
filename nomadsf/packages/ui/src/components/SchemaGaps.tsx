import { useEffect, useState } from 'react';
import {
  folderBytes,
  packageXml,
  projectMetadataZip,
  projectFiles,
  resolveComponent,
  neededToo,
  piecesZip,
  rolesToo,
  schemaPlan,
  type AddedPiece,
  type AccessFile,
  type SalesforceClient,
  type SchemaNeed,
  type SchemaWant,
  type DeployOutcome,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { useProject } from '../project';
import { download } from './DataTable';
import { ReleasePanel } from './ReleasePanel';
import { Select } from './Select';

type Component = { type: string; name: string };
const keyOf = (c: Component) => `${c.type}:${c.name}`;
const NONE: Array<{ name: string }> = [];
const PLURAL: Record<string, string> = {
  Role: 'Roles',
  Group: 'Public groups and queues',
  CustomObject: 'Objects',
  CustomField: 'Fields',
  ApexClass: 'Apex classes',
};
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
  preferFrom,
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
  /** The org to take them from first, by label (the org a workbook was saved in), when it is connected. */
  preferFrom?: string;
}) {
  const studio = useStudio();
  const project = useProject();
  const [plan, setPlan] = useState<{ needs: SchemaNeed[]; components: Component[]; unavailable: string[] } | null>(
    null
  );
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState<string>('');
  const [checks, setChecks] = useState(0);
  // What those pieces use in the org they come from, that the target lacks too (null: still reading)
  const [also, setAlso] = useState<AddedPiece[] | null>([]);
  // A deploy from here went through: once nothing is missing, it says so instead of disappearing
  const [deployed, setDeployed] = useState(false);
  // The last deploy's errors, by piece: they stay until the next deploy (to see what to change, or to untick)
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [unmatched, setUnmatched] = useState<string[]>([]);
  // The groups opened (by kind); a short group starts open
  const [opened, setOpened] = useState<Set<string> | null>(null);
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
    // The org they came from (connected), else the project, else another org
    const preferred = others.find((o) => o.label === preferFrom);
    setFrom(preferred?.id ?? (project.source ? 'project' : others[0]?.id ?? ''));
  }, [from, project.source, others, preferFrom]);
  // From the project: which pieces it has (the rest cannot come from there)
  const [inProject, setInProject] = useState<Set<string> | null>(null);
  useEffect(() => {
    setInProject(null);
    if (from !== 'project' || !project.info || !project.source || !plan) return undefined;
    let canceled = false;
    const info = project.info;
    const dirs = info.packageDirectories.map((d) => d.path);
    void projectFiles(project.source.fs, info)
      .then((files) => {
        const keys = new Set<string>();
        for (const f of files) {
          const c = resolveComponent(f, dirs);
          if (c && !c.labels) keys.add(`${c.type}:${c.name}`);
        }
        if (!canceled) setInProject(keys);
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [from, project.info, project.source, plan]);

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

  if (!plan || (!plan.components.length && !plan.unavailable.length))
    return deployed && plan ? (
      <p className="good">
        ✓ Deployed: {target.label} has everything {forWhat} need.
      </p>
    ) : null;
  const all: Array<Component & { neededBy: string[]; uses?: boolean }> = [
    ...plan.components.map((c) => ({
      ...c,
      neededBy: plan.needs
        .filter(
          (n) =>
            (c.type === 'CustomObject' && n.objects.includes(c.name)) ||
            (c.type === 'CustomField' && n.fields.includes(c.name)) ||
            (c.type === 'ApexClass' && n.classes.includes(c.name)) ||
            (c.type === 'Role' && n.roles.includes(c.name)) ||
            (c.type === 'Group' && n.groups.includes(c.name))
        )
        .map((n) => n.name),
    })),
    ...(also ?? []).map((c) => ({ type: c.type, name: c.name, neededBy: [c.neededBy], uses: true })),
  ];
  const chosen = all.filter((c) => ticked.has(keyOf(c)));
  const setMany = (keys: string[], on: boolean) => {
    const next = new Set(ticked);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    setTicked(next);
  };
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
  // A deploy's errors on our pieces (a queue fails as Queue, a field as Object.Field)
  const remember = (outcome: DeployOutcome) => {
    const map = new Map<string, string>();
    const rest: string[] = [];
    for (const f of outcome.componentFailures) {
      const type = f.type === 'Queue' ? 'Group' : f.type;
      const piece = all.find((c) => c.type === type && (c.name === f.name || f.name.endsWith(`.${c.name}`)));
      if (piece) map.set(keyOf(piece), [map.get(keyOf(piece)), f.problem].filter(Boolean).join('; '));
      else rest.push(`${f.type} ${f.name}: ${f.problem}`);
    }
    setFailures(map);
    setUnmatched(rest);
    // A failed group opens, to show its errors
    if (map.size) setOpened(new Set([...(opened ?? []), ...all.filter((c) => map.has(keyOf(c))).map((c) => c.type)]));
  };
  const failedTicked = all.filter((c) => failures.has(keyOf(c)) && ticked.has(keyOf(c)));
  const groups = (['Role', 'Group', 'CustomObject', 'CustomField', 'ApexClass'] as const)
    .map((type) => ({ type, list: all.filter((c) => c.type === type) }))
    .filter((g) => g.list.length);
  const isOpen = (type: string, size: number) => (opened ? opened.has(type) : size <= 6);
  const toggle = (type: string, size: number) => {
    const next = new Set(opened ?? groups.filter((g) => g.list.length <= 6).map((g) => g.type));
    if (isOpen(type, size)) next.delete(type);
    else next.add(type);
    setOpened(next);
  };

  return (
    <div className="note warn-box schema-gaps">
      <b>
        {target.label} lacks what {forWhat} need. Deploy it first, then they go in whole (otherwise what needs it fails
        or is left out).
      </b>
      {plan.unavailable.length > 0 && (
        <p className="muted small">
          Not deployable — standard objects {target.label} does not have (a feature or license it lacks):{' '}
          {plan.unavailable.join(', ')}. What needs them is left out there.
        </p>
      )}
      {also === null && <p className="muted small">Reading what they use in {sourceLabel(from)}…</p>}
      {from === 'project' && inProject && (
        <p className="muted small">
          {(() => {
            const absent = all.filter(
              (c) =>
                !inProject.has(keyOf(c)) &&
                !(c.type === 'CustomField' && inProject.has(`CustomObject:${c.name.split('.')[0]}`))
            );
            return absent.length
              ? `⚠ Not in the project (they cannot come from there — choose an org): ${absent
                  .map((c) => c.name)
                  .join(', ')}. `
              : '';
          })()}
          What these use in turn is followed when they come from an org.
        </p>
      )}
      {failedTicked.length > 0 && (
        <div className="form">
          <span className="bad">❌ {failedTicked.length} failed in the last deploy (their errors are below).</span>
          <button onClick={() => setMany(failedTicked.map(keyOf), false)}>
            Untick the {failedTicked.length} failed
          </button>
        </div>
      )}
      {unmatched.length > 0 && (
        <ul className="bad small">
          {unmatched.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      )}
      <div className="gap-groups">
        {groups.map(({ type, list }) => {
          const keys = list.map(keyOf);
          const on = keys.filter((k) => ticked.has(k)).length;
          const bad = keys.filter((k) => failures.has(k)).length;
          const open = isOpen(type, list.length);
          return (
            <div key={type} className="gap-group">
              <div className="gap-head">
                <button className="link tree-toggle" onClick={() => toggle(type, list.length)} aria-expanded={open}>
                  {open ? '▾' : '▸'}
                </button>
                <input
                  type="checkbox"
                  aria-label={`All ${KIND[type]}`}
                  checked={on === keys.length}
                  ref={(el) => {
                    if (el) el.indeterminate = on > 0 && on < keys.length;
                  }}
                  onChange={(e) => setMany(keys, e.target.checked)}
                />
                <button className="link gap-title" onClick={() => toggle(type, list.length)}>
                  <b>{PLURAL[type]}</b> <span className="muted">{list.length}</span>
                </button>
                <span className="pill">{on} ticked</span>
                {bad > 0 && <span className="pill bad">{bad} failed</span>}
              </div>
              {open && (
                <ul className="gap-rows">
                  {list.map((c) => {
                    const k = keyOf(c);
                    return (
                      <li key={k} className={failures.has(k) ? 'failed' : ''}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={ticked.has(k)}
                            onChange={(e) => setMany([k], e.target.checked)}
                          />{' '}
                          <span className="mono">{c.name}</span>
                          {c.type === 'CustomObject' && <span className="muted"> (with its fields)</span>}
                        </label>
                        <span className="muted small">
                          {c.uses ? 'used by' : 'for'} {c.neededBy.join(', ') || '—'}
                        </span>
                        {failures.has(k) && <span className="bad small gap-error">❌ {failures.get(k)}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
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
              `needed-first.package.xml`,
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
          // Kept while ticks change: its last result (and errors) stay on screen
          key={from}
          deployCount={chosen.length}
          removeCount={0}
          from={from === 'project' ? 'the project' : sourceOrg?.label ?? ''}
          build={build}
          targetId={target.id}
          zipName="needed-first.zip"
          onDone={(outcome) => {
            remember(outcome);
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
