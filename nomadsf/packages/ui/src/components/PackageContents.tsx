import { useState } from 'react';
import { pairCodeFiles, type CodeFile } from '@nomadsf/core';
import { ProjectCodeView } from './ProjectCodeView';
import { Status } from '../statusLog';

/**
 * What a package holds, at the end of every place that builds one: package.xml and destructiveChanges.xml by type,
 * then each component — click one to see its code (both sides when the page has both: org ↔ project, A ↔ B…).
 */

type Component = { type: string; name: string };

/** One component's files on each side; a side left out is not shown. */
export type ComponentCode = { before?: CodeFile[]; after?: CodeFile[]; labels: [string, string] };

const byType = (list: Component[]): string =>
  [...list.reduce((m, c) => m.set(c.type, (m.get(c.type) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');

export function PackageContents({
  deploy,
  remove,
  loadCode,
}: {
  deploy: Component[];
  remove: Component[];
  /** The files of one component, when the page can read them. */
  loadCode?: (component: Component) => Promise<ComponentCode>;
}) {
  const [open, setOpen] = useState<{ key: string; code?: ComponentCode; error?: string }>();
  const [path, setPath] = useState('');
  if (!deploy.length && !remove.length) return null;

  const show = async (c: Component): Promise<void> => {
    const key = `${c.type}:${c.name}`;
    if (open?.key === key) {
      setOpen(undefined);
      return;
    }
    setPath('');
    setOpen({ key });
    try {
      const code = await loadCode!(c);
      setOpen({ key, code });
    } catch (e) {
      setOpen({ key, error: (e as Error).message });
    }
  };

  const list = (title: string, items: Component[], tone: string, file: string) =>
    items.length > 0 && (
      <details className="package-list" open={items.length <= 30}>
        <summary>
          <b>{title}</b> <span className={`pill ${tone}`}>{items.length}</span> <span className="muted">— {file}</span>
        </summary>
        <ul>
          {[...items]
            .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
            .map((c) => {
              const key = `${c.type}:${c.name}`;
              return (
                <li key={key} className={open?.key === key ? 'active' : ''}>
                  <span className="muted">{c.type}</span>
                  {loadCode ? (
                    <button className="link" title="See its code" onClick={() => void show(c)}>
                      {c.name}
                    </button>
                  ) : (
                    <span>{c.name}</span>
                  )}
                </li>
              );
            })}
        </ul>
      </details>
    );

  const code = open?.code;
  const single = code && (!code.before || !code.after);
  return (
    <div className="card section package-contents">
      <h3>What&apos;s in the package</h3>
      <p>
        <b>package.xml</b> {byType(deploy) || '—'}
      </p>
      {remove.length > 0 && (
        <p>
          <b>destructiveChanges.xml</b> {byType(remove)}
        </p>
      )}
      {list('To deploy', deploy, 'good', 'package.xml')}
      {list('To delete', remove, 'bad', 'destructiveChanges.xml')}
      {open && (
        <div className="package-code">
          <div className="form">
            <h4 className="grow">{open.key.replace(':', ' · ')}</h4>
            <button onClick={() => setOpen(undefined)}>Close</button>
          </div>
          {open.error ? (
            <Status text={`❌ ${open.error}`} block />
          ) : !code ? (
            <p className="muted">Reading its files…</p>
          ) : (
            <ProjectCodeView
              key={open.key}
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
