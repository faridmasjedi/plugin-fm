import { unifiedDiff, type CodePair } from '@nomadsf/core';
import { AiExplain } from './AiHelp';
import { CodeDiff } from './CodeDiff';
import { CodeEditor } from './CodeEditor';

const MARK: Record<CodePair['status'], string> = {
  same: '',
  different: ' ●',
  'only in org': ' −',
  'only in project': ' +',
};

/** Picks the file to show: the chosen one, else the first that differs. */
export const shownPair = (pairs: CodePair[], path: string): CodePair | undefined =>
  pairs.find((p) => p.path === path) ?? pairs.find((p) => p.status !== 'same') ?? pairs[0];

/**
 * The project's version of a component (read-only) or the org ↔ project difference, file by
 * file for LWC and Aura bundles.
 */
export function ProjectCodeView({
  pairs,
  view,
  labels,
  path,
  onPath,
}: {
  pairs: CodePair[];
  view: 'project' | 'compare';
  /** [org, project] */
  labels: [string, string];
  path: string;
  onPath: (path: string) => void;
}) {
  const pair = shownPair(pairs, path);
  if (!pair) return <p className="muted">No files.</p>;
  return (
    <>
      {pairs.length > 1 && (
        <div className="tabs">
          {pairs.map((p) => (
            <button
              key={p.path}
              className={`tab ${p.path === pair.path ? 'active' : ''}`}
              title={p.status}
              onClick={() => onPath(p.path)}
            >
              {p.path.split('/').pop()}
              {MARK[p.status]}
            </button>
          ))}
        </div>
      )}
      {(pair.status === 'different' || (view === 'project' && pair.project)) && (
        <div className="chips ai-tools">
          {pair.status === 'different' && (
            <AiExplain
              key={`diff:${pair.path}`}
              task="explain-diff"
              label="Explain the difference"
              what="the difference of this file (a diff, not the whole org)"
              getText={() => unifiedDiff(pair.org!.source, pair.project!.source, labels)}
              getExtra={() => `File: ${pair.path}`}
            />
          )}
          {view === 'project' && pair.project && (
            <>
              <AiExplain
                key={`explain:${pair.path}`}
                task="explain-code"
                label="Explain"
                what={`this file (${labels[1]})`}
                getText={() => pair.project!.source}
                getExtra={() => `File: ${pair.path}`}
              />
              <AiExplain
                key={`review:${pair.path}`}
                task="review-code"
                label="Review"
                what={`this file (${labels[1]})`}
                getText={() => pair.project!.source}
                getExtra={() => `File: ${pair.path}`}
              />
            </>
          )}
        </div>
      )}
      {view === 'project' &&
        (pair.project ? (
          <div className="editor-box tall">
            <CodeEditor key={pair.path} language={pair.project.language} value={pair.project.source} readOnly />
          </div>
        ) : (
          <p className="muted">This file is in {labels[0]} only, not in the project.</p>
        ))}
      {view === 'compare' && (
        <CodeDiff
          key={pair.path}
          original={pair.org?.source ?? ''}
          modified={pair.project?.source ?? ''}
          language={(pair.org ?? pair.project)!.language}
          labels={[
            pair.org ? labels[0] : `${labels[0]} (no such file)`,
            pair.project ? labels[1] : `${labels[1]} (no such file)`,
          ]}
        />
      )}
    </>
  );
}
