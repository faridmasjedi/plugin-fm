import { useState } from 'react';
import {
  codeLanguageOf,
  folderBytes,
  fromBase64,
  pairCodeFiles,
  projectFiles,
  retrieveZip,
  toSourceFormat,
  writeFolderFile,
  type SourceWrite,
  type ToSourceResult,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { useProject } from '../project';
import { Status } from '../statusLog';
import { askConfirm } from './Dialogs';
import { ProjectCodeView } from './ProjectCodeView';

/**
 * Retrieve into the project: the chosen components from the org, as the files they would be in the project (source
 * format, where each already is or in the default package folder) — new, changed or the same, each with its difference.
 * Nothing is written until "Write … into the project" (the browser asks once to let NomadSF write to the folder).
 */

type Component = { type: string; name: string };

const STATUS: Record<SourceWrite['status'], { mark: string; tone: string; word: string }> = {
  new: { mark: 'A', tone: 'good', word: 'new in the project' },
  changed: { mark: 'M', tone: 'warn', word: 'replaces the project’s file' },
  same: { mark: '=', tone: '', word: 'the same as the project' },
};

export function RetrieveIntoProject({ components, from }: { components: Component[]; from?: string }) {
  const studio = useStudio();
  const project = useProject();
  const [result, setResult] = useState<ToSourceResult>();
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const source = project.source;
  const handle = source?.kind === 'folder' ? source.handle : undefined;
  if (!source || !project.info)
    return <p className="note">Choose the project in Settings › Project to retrieve into it.</p>;
  if (!handle)
    return (
      <p className="note">
        Retrieving writes files, so it needs the project <b>folder</b> (Settings › Project › Choose project folder…)
        {source.kind === 'github' ? ' — a GitHub project is read-only here.' : '.'}
      </p>
    );

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const read = () =>
    run(`Retrieving ${components.length} component(s) from ${from ?? studio.org.label}…`, async () => {
      setOpen(undefined);
      const retrieved = await retrieveZip(
        studio.client,
        components.map((c) => ({ type: c.type, fullName: c.name })),
        { onProgress: (s) => setStatus(`Retrieving · ${s}…`) }
      );
      if (!retrieved.zipFile) throw new Error(retrieved.errorMessage ?? 'The org returned no files.');
      setStatus('Comparing with the project…');
      const info = project.info!;
      const files = await projectFiles(source.fs, info);
      const dirs = info.packageDirectories.map((d) => d.path);
      const out = await toSourceFormat({
        zip: fromBase64(retrieved.zipFile),
        props: retrieved.files,
        projectFiles: files,
        read: (path) => folderBytes(handle, path).catch(() => undefined),
        packageDirs: dirs,
        defaultDir: info.packageDirectories.find((d) => d.default)?.path ?? dirs[0] ?? 'force-app',
      });
      setResult(out);
      setSkip(new Set());
      const n = (s: SourceWrite['status']) => out.writes.filter((w) => w.status === s).length;
      setStatus(`✓ ${n('new')} new, ${n('changed')} changed, ${n('same')} the same as the project.`);
    });

  const toWrite = (result?.writes ?? []).filter((w) => w.status !== 'same' && !skip.has(w.path));

  const write = async (): Promise<void> => {
    const changed = toWrite.filter((w) => w.status === 'changed').length;
    if (
      !(await askConfirm(
        `Write ${toWrite.length} file(s) into the project folder ${source.name}?${
          changed ? `\n\n${changed} of them replace the project's file.` : ''
        }`,
        { ok: 'Write', danger: changed > 0 }
      ))
    )
      return;
    await run('Writing into the project…', async () => {
      const h = handle as unknown as { requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState> };
      if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted')
        throw new Error('NomadSF may not write to the folder (the browser asked, and it was not allowed).');
      // eslint-disable-next-line no-await-in-loop
      for (const w of toWrite) await writeFolderFile(handle, w.path, w.content);
      studio.logActivity('retrieve into project', {
        project: source.name,
        files: toWrite.length,
        from: from ?? studio.org.label,
      });
      setStatus(`✓ Wrote ${toWrite.length} file(s) into ${source.name}.`);
      setResult(undefined);
      await project.refresh();
    });
  };

  const shown = result?.writes.find((w) => w.path === open);
  return (
    <div className="card section retrieve-into">
      <div className="form">
        <h3 className="grow">Retrieve into the project</h3>
        <span className="muted">
          {components.length} component(s) → {source.name}
        </span>
        <button className="primary" disabled={busy} onClick={() => void read()}>
          {result ? 'Read again' : 'Read from the org'}
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        The files are shown first — nothing is written until you press <b>Write</b>.
      </p>
      {status && <Status text={status} block />}
      {result && result.notConverted.length > 0 && (
        <p className="warn-text">
          ⚠ Not retrieved: {result.notConverted.map((c) => `${c.type} ${c.name} (${c.reason})`).join('; ')}
        </p>
      )}
      {result && (
        <>
          <div className="compare-file-rows">
            {result.writes.map((w) => (
              <div key={w.path} className={`compare-file-row${open === w.path ? ' active' : ''}`}>
                <input
                  type="checkbox"
                  title={w.status === 'same' ? 'Already the same' : 'Write this file'}
                  disabled={w.status === 'same'}
                  checked={w.status !== 'same' && !skip.has(w.path)}
                  onChange={(e) => {
                    const next = new Set(skip);
                    if (e.target.checked) next.delete(w.path);
                    else next.add(w.path);
                    setSkip(next);
                  }}
                />
                <span className={`pill ${STATUS[w.status].tone}`} title={STATUS[w.status].word}>
                  {STATUS[w.status].mark}
                </span>
                <button className="link mono" onClick={() => setOpen(open === w.path ? undefined : w.path)}>
                  {w.path}
                </button>
                <span className="muted small">
                  {w.type} {w.name}
                </span>
              </div>
            ))}
          </div>
          {shown && (
            <div className="package-code">
              <ProjectCodeView
                key={shown.path}
                pairs={(() => {
                  const file = (side: string, text: string) => ({
                    id: `${side}:${shown.path}`,
                    path: shown.path,
                    language: codeLanguageOf(shown.path),
                    source: text,
                  });
                  const after = file('org', new TextDecoder().decode(shown.content));
                  // A new file alone (in the viewer's single slot); a changed one next to the project's
                  return shown.before === undefined
                    ? pairCodeFiles([], [after])
                    : pairCodeFiles([after], [file('project', shown.before)]);
                })()}
                view={shown.before === undefined ? 'project' : 'compare'}
                labels={[from ?? studio.org.label, `project ${source.name}`]}
                path={shown.path}
                onPath={() => undefined}
              />
            </div>
          )}
          <div className="form">
            <button className="primary" disabled={busy || !toWrite.length} onClick={() => void write()}>
              Write {toWrite.length} file(s) into the project
            </button>
          </div>
        </>
      )}
    </div>
  );
}
