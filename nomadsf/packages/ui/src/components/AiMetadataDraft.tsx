import { useState } from 'react';
import {
  apexSourcesFromFiles,
  apexSourcesFromOrg,
  makeZip,
  manifestXml,
  metadataComponentsOf,
  testsForPackage,
  type DeployOutcome,
  type MetadataDraft,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { CodeEditor, type CodeEditorProps } from './CodeEditor';
import { ReleasePanel } from './ReleasePanel';

/**
 * Metadata written by AI (a trigger, an LWC, a field…): its files to read and change, then created through the same
 * validate / deploy panel as every package — nothing reaches the org before that.
 */

const languageOf = (path: string): CodeEditorProps['language'] => {
  if (/\.(cls|trigger)$/.test(path)) return 'apex';
  if (path.endsWith('.js')) return 'javascript';
  if (/\.(html|page|component|cmp|app|evt|intf|auradoc|design)$/.test(path)) return 'html';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  return 'xml';
};

export function AiMetadataDraft({
  draft,
  model,
  onChange,
  onDiscard,
  onDone,
}: {
  draft: MetadataDraft;
  model: string;
  onChange: (draft: MetadataDraft) => void;
  onDiscard: () => void;
  /** After a successful deploy (the page refreshes its list). */
  onDone?: () => void;
}) {
  const studio = useStudio();
  const [index, setIndex] = useState(0);
  const [deploying, setDeploying] = useState(false);
  const file = draft.files[Math.min(index, draft.files.length - 1)];
  const components = metadataComponentsOf(draft.files);

  const build = async () => {
    const version = await studio.client.version();
    // An API version newer than the org's (the AI guessing one) would fail the whole deploy
    const capped = (content: string): string =>
      content.replace(/<apiVersion>([\d.]+)<\/apiVersion>/g, (whole, v: string) =>
        Number(v) > Number(version) ? `<apiVersion>${version}</apiVersion>` : whole
      );
    return {
      zip: makeZip([
        { path: 'package.xml', content: manifestXml(components, version) },
        ...draft.files.map((f) => ({ path: f.path, content: capped(f.content) })),
      ]),
    };
  };

  // The tests: the org's Apex plus the draft's (a new class and its test reach each other)
  const findTests = async () => {
    const mine = await apexSourcesFromFiles(
      draft.files.map((f) => f.path),
      async (path) => draft.files.find((f) => f.path === path)?.content ?? ''
    );
    const names = new Set(mine.map((m) => m.name));
    const org = (await apexSourcesFromOrg(studio.client)).filter((s) => !names.has(s.name));
    return testsForPackage([...org, ...mine], components);
  };

  return (
    <div className="card section ai-answer">
      <div className="toolbar">
        <b>✦ Written by AI</b>
        <span className="muted">
          {model} · {components.map((c) => `${c.type} ${c.name}`).join(', ') || 'no component found'} · read and change
          it, nothing is created yet
        </span>
        <span className="grow" />
        <button className="primary" disabled={!components.length} onClick={() => setDeploying(!deploying)}>
          Create / deploy…
        </button>
        <button onClick={onDiscard}>Discard</button>
      </div>
      {draft.note && <p className="muted">{draft.note}</p>}
      {draft.files.length > 1 && (
        <div className="tabs">
          {draft.files.map((f, i) => (
            <button key={f.path} className={`tab ${f === file ? 'active' : ''}`} onClick={() => setIndex(i)}>
              {f.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      {file && (
        <div className="editor-box">
          <CodeEditor
            key={file.path}
            language={languageOf(file.path)}
            value={file.content}
            onChange={(content) =>
              onChange({ ...draft, files: draft.files.map((f) => (f.path === file.path ? { ...f, content } : f)) })
            }
          />
        </div>
      )}
      {deploying && (
        <ReleasePanel
          deployCount={components.length}
          removeCount={0}
          from="the AI draft"
          build={build}
          findTests={findTests}
          targetId={studio.org.id}
          zipName={`${draft.name || 'ai-draft'}.zip`}
          onDone={(outcome: DeployOutcome) => {
            if (outcome.success && !outcome.checkOnly) onDone?.();
          }}
        />
      )}
    </div>
  );
}
