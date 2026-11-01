import { useEffect, useState } from 'react';
import { pairCodeFiles, type CodeFile } from '@nomadsf/core';
import { ProjectCodeView } from './ProjectCodeView';
import { Status } from '../statusLog';

/**
 * What a package holds, at the end of every place that builds one, the way Compare & package lists a branch's files:
 * package.xml and destructiveChanges.xml by type, then "Changed / added" and "Deleted" with a row per file (or per
 * component, when the files are in an org) — click one to see its code (both sides when the page has both).
 */

type Component = { type: string; name: string };

/** One component's files on each side; a side left out is not shown. */
export type ComponentCode = { before?: CodeFile[]; after?: CodeFile[]; labels: [string, string] };

/** A for added, M for changed (in both), D for deleted; • when the page cannot tell. */
export type FileStatus = 'A' | 'M' | 'D' | '•';

const TONE: Record<FileStatus, string> = { A: 'good', M: 'warn', D: 'bad', '•': '' };
const WORD: Record<FileStatus, string> = { A: 'added', M: 'changed', D: 'deleted', '•': 'to deploy' };
const keyOf = (c: Component): string => `${c.type}:${c.name}`;

const byType = (list: Component[]): string =>
  [...list.reduce((m, c) => m.set(c.type, (m.get(c.type) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');

type Row = { id: string; status: FileStatus; label: string; components: Component[]; path?: string };

export function PackageContents({
  deploy,
  remove,
  loadCode,
  statusOf,
  listFiles,
}: {
  deploy: Component[];
  remove: Component[];
  /** The files of one component, when the page can read them. */
  loadCode?: (component: Component) => Promise<ComponentCode>;
  /** Added or changed, when the page knows. */
  statusOf?: (component: Component) => FileStatus;
  /** Each component's source files, when they are in a project or branch (else one row per component). */
  listFiles?: (components: Component[]) => Promise<Map<string, string[]>>;
}) {
  const [open, setOpen] = useState<{ id: string; path?: string; code?: ComponentCode; error?: string }>();
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<Map<string, string[]>>();
  const signature = [...deploy.map((c) => `+${keyOf(c)}`), ...remove.map((c) => `-${keyOf(c)}`)].join('|');

  // The source files of the components (a project or branch): read again when the package changes
  useEffect(() => {
    setFiles(undefined);
    if (!listFiles || (!deploy.length && !remove.length)) return undefined;
    let canceled = false;
    listFiles([...deploy, ...remove])
      .then((found) => !canceled && setFiles(found))
      .catch(() => !canceled && setFiles(new Map()));
    return () => {
      canceled = true;
    };
    // the signature stands for both lists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (!deploy.length && !remove.length) return null;

  /** A row per file (a file shared by components, like labels, once), or per component without files. */
  const rows = (list: Component[], deleting: boolean): Row[] => {
    const status = (c: Component): FileStatus => (deleting ? 'D' : statusOf?.(c) ?? '•');
    if (!files)
      return list.map((c) => ({ id: keyOf(c), status: status(c), label: `${c.type} ${c.name}`, components: [c] }));
    const byPath = new Map<string, Row>();
    const loose: Row[] = [];
    for (const c of list) {
      const paths = files.get(keyOf(c)) ?? [];
      if (!paths.length) loose.push({ id: keyOf(c), status: status(c), label: `${c.type} ${c.name}`, components: [c] });
      for (const p of paths) {
        const row = byPath.get(p);
        if (row) row.components.push(c);
        else byPath.set(p, { id: p, path: p, status: status(c), label: '', components: [c] });
      }
    }
    for (const row of byPath.values())
      row.label =
        row.components.length === 1
          ? `${row.components[0].type} ${row.components[0].name}`
          : `${row.components[0].type}: ${row.components.map((c) => c.name).join(', ')}`;
    return [...[...byPath.values()].sort((a, b) => a.id.localeCompare(b.id)), ...loose];
  };

  const show = async (row: Row): Promise<void> => {
    if (open?.id === row.id) {
      setOpen(undefined);
      return;
    }
    setPath('');
    setOpen({ id: row.id, path: row.path });
    try {
      const code = await loadCode!(row.components[0]);
      setOpen({ id: row.id, path: row.path, code });
      // The file clicked, among the component's files (the Metadata API's paths end like the source ones)
      if (row.path) {
        const name = (row.path.split('/').pop() ?? '').replace(/-meta\.xml$/, '');
        const all = [...(code.before ?? []), ...(code.after ?? [])];
        const match =
          all.find((f) => f.path.split('/').pop() === row.path!.split('/').pop()) ??
          all.find((f) => (f.path.split('/').pop() ?? '').replace(/-meta\.xml$/, '') === name);
        if (match) setPath(match.path);
      }
    } catch (e) {
      setOpen({ id: row.id, path: row.path, error: (e as Error).message });
    }
  };

  const group = (label: string, hint: string, list: Row[], tone: string) =>
    list.length > 0 && (
      <details className="compare-file-group" open>
        <summary>
          <b>{label}</b> <span className={`pill ${tone}`}>{list.length}</span> <span className="muted">— {hint}</span>
        </summary>
        <div className="compare-file-rows">
          {list.map((row) => (
            <div key={row.id} className={`compare-file-row${open?.id === row.id ? ' active' : ''}`}>
              <span className={`pill ${TONE[row.status]}`} title={WORD[row.status]}>
                {row.status}
              </span>
              {loadCode ? (
                <button className="link mono" title="See its code" onClick={() => void show(row)}>
                  {row.path ?? row.components[0].name}
                </button>
              ) : (
                <span className="mono">{row.path ?? row.components[0].name}</span>
              )}
              <span className="muted small">{row.label}</span>
            </div>
          ))}
        </div>
      </details>
    );

  const code = open?.code;
  const single = code && (!code.before || !code.after);
  return (
    <div className="card section package-contents">
      <h3>What&apos;s in the package</h3>
      <div className="compare-summary">
        <p>
          <b>package.xml</b> {byType(deploy) || '—'}
        </p>
        {remove.length > 0 && (
          <p>
            <b>destructiveChanges.xml</b> {byType(remove)}
          </p>
        )}
      </div>
      <div className="compare-files">
        <h4>{files ? 'Files' : 'Components'}</h4>
        {group('Changed / added', 'go into package.xml', rows(deploy, false), 'good')}
        {group('Deleted', 'go into destructiveChanges.xml', rows(remove, true), 'bad')}
      </div>
      {open && (
        <div className="package-code">
          <div className="form">
            <h4 className="grow">{open.path ?? open.id.replace(':', ' · ')}</h4>
            <button onClick={() => setOpen(undefined)}>Close</button>
          </div>
          {open.error ? (
            <Status text={`❌ ${open.error}`} block />
          ) : !code ? (
            <p className="muted">Reading its files…</p>
          ) : (
            <ProjectCodeView
              key={open.id}
              pairs={
                single
                  ? pairCodeFiles([], code.after ?? code.before ?? [])
                  : pairCodeFiles(code.before ?? [], code.after ?? [])
              }
              view={single ? 'project' : 'compare'}
              labels={single ? [code.labels[code.after ? 0 : 1], code.labels[code.after ? 1 : 0]] : code.labels}
              path={path}
              onPath={setPath}
            />
          )}
        </div>
      )}
    </div>
  );
}
