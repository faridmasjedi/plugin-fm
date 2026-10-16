import { describe, expect, it } from 'vitest';
import { analyzeProject, githubProjectFs, listRepos, type GitHubTransport } from '../src/index.js';

/** Fake GitHub: answers the tree call, file contents and repo pages. */
function fakeGitHub(files: Record<string, string>, calls: string[] = []): GitHubTransport {
  const paths = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) paths.add(`tree:${parts.slice(0, i).join('/')}`);
    paths.add(`blob:${file}`);
  }
  return {
    async get(path, raw) {
      calls.push(path);
      if (path.includes('/git/trees/')) {
        const tree = [...paths].map((p) => ({ type: p.split(':')[0], path: p.slice(p.indexOf(':') + 1) }));
        return { status: 200, text: JSON.stringify({ tree, truncated: false }) };
      }
      const content = /\/contents\/([^?]+)/.exec(path);
      if (content && raw) {
        const file = decodeURIComponent(content[1]);
        return files[file] === undefined ? { status: 404, text: '' } : { status: 200, text: files[file] };
      }
      if (path.startsWith('/user/repos')) {
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
        const count = page === 1 ? 100 : 3;
        const repos = Array.from({ length: count }, (_, i) => ({
          full_name: `me/r${page}-${i}`,
          default_branch: 'main',
          private: true,
        }));
        return { status: 200, text: JSON.stringify(repos) };
      }
      return { status: 404, text: '{"message":"Not Found"}' };
    },
  };
}

describe('github project', () => {
  it('reads a repository branch as a Salesforce project with one tree call', async () => {
    const calls: string[] = [];
    const api = fakeGitHub(
      {
        'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }),
        'force-app/main/default/classes/A.cls': '',
        'force-app/main/default/classes/A.cls-meta.xml': '<x/>',
        'node_modules/x/package.json': '{}',
        'manifest/package.xml': '<Package><types><members>A</members><name>ApexClass</name></types></Package>',
      },
      calls
    );
    const info = await analyzeProject(githubProjectFs(api, 'me/repo', 'release/1'));
    expect(info.name).to.equal('repo');
    expect(info.branch).to.equal('release/1');
    expect(info.packageDirectories[0].types[0]).to.include({ type: 'ApexClass', count: 1 });
    expect(info.manifests).to.deep.equal([{ path: 'manifest/package.xml', types: 1, members: 1 }]);
    expect(calls.filter((c) => c.includes('/git/trees/'))).to.have.length(1);
    expect(calls.some((c) => c.includes('node_modules'))).to.equal(false);
  });

  it('pages through the repositories', async () => {
    const repos = await listRepos(fakeGitHub({}));
    expect(repos).to.have.length(103);
    expect(repos[0]).to.include({ fullName: 'me/r1-0', defaultBranch: 'main', private: true });
  });
});
