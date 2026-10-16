import { useCallback, useEffect, useRef, useState } from 'react';
import {
  finishDeviceFlow,
  githubUser,
  listBranches,
  listRepos,
  startDeviceFlow,
  tokenTransport,
  type DeviceCode,
  type GitHubRepo,
} from '@nomadsf/core';
import { storage } from '../context';
import { currentGitHub, githubClientId, githubToken, lastRepo, type GitHubConnection } from '../github';
import { useProject } from '../project';

/** Connect GitHub, then open any repository and branch as the project. */
export function GitHubCard({ hostKind }: { hostKind: 'app' | 'extension' }) {
  const project = useProject();
  const [connection, setConnection] = useState<GitHubConnection & { login: string }>();
  const [checking, setChecking] = useState(true);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [filter, setFilter] = useState('');
  const [repo, setRepo] = useState(lastRepo.get()?.fullName ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [ref, setRef] = useState(lastRepo.get()?.ref ?? '');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState(githubClientId());
  const [device, setDevice] = useState<DeviceCode>();
  const [message, setMessage] = useState('');
  const abort = useRef<AbortController | undefined>(undefined);
  // github.com's sign-in endpoints allow no browser CORS; the extension's host permission covers them
  const canSignIn = hostKind === 'extension';

  const connect = useCallback(async () => {
    setChecking(true);
    setMessage('');
    try {
      const next = await currentGitHub(hostKind);
      if (!next) {
        setConnection(undefined);
        return;
      }
      const user = await githubUser(next.api);
      setConnection({ ...next, login: user.login });
      setRepos(await listRepos(next.api));
    } catch (e) {
      setConnection(undefined);
      setMessage(`❌ ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  }, [hostKind]);

  useEffect(() => {
    void connect();
    return () => abort.current?.abort();
  }, [connect]);

  // Branches of the chosen repository
  useEffect(() => {
    if (!connection || !repo) return;
    const known = repos.find((r) => r.fullName === repo);
    listBranches(connection.api, repo)
      .then((list) => {
        setBranches(list);
        setRef((current) => (list.includes(current) ? current : known?.defaultBranch ?? list[0] ?? ''));
      })
      .catch((e: Error) => setMessage(`❌ ${e.message}`));
  }, [connection, repo, repos]);

  const useToken = async (value: string) => {
    try {
      await githubUser(tokenTransport(value.trim()));
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`);
      return;
    }
    githubToken.set(value);
    setToken('');
    await connect();
  };

  const signIn = async () => {
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      storage.set('github.clientId', clientId.trim());
      const code = await startDeviceFlow(clientId.trim());
      setDevice(code);
      window.open(code.verificationUri, '_blank', 'noopener');
      await useToken(await finishDeviceFlow(clientId.trim(), code, abort.current.signal));
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`);
    } finally {
      setDevice(undefined);
    }
  };

  const disconnect = async () => {
    githubToken.clear();
    setRepos([]);
    setBranches([]);
    await connect();
  };

  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())).slice(0, 200);

  return (
    <div className="card section">
      <h3>From GitHub</h3>
      {checking && <p className="muted">Checking GitHub…</p>}
      {!checking && connection && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Connected as <b>@{connection.login}</b> ·{' '}
            {connection.mode === 'app' ? 'GitHub CLI login of the local app' : 'token in this browser'}
            {connection.mode === 'token' && (
              <>
                {' '}
                ·{' '}
                <button className="link" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              </>
            )}
          </p>
          <div className="form">
            <input
              placeholder={`Filter ${repos.length} repositories`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ maxWidth: 320 }}>
              <option value="">Choose a repository…</option>
              {shown.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? ' 🔒' : ''}
                </option>
              ))}
            </select>
            <select value={ref} onChange={(e) => setRef(e.target.value)} disabled={!branches.length}>
              {branches.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            <button
              className={project.source?.kind === 'github' ? '' : 'primary'}
              disabled={!repo || !ref || project.loading}
              onClick={() => void project.openGitHub(connection.api, repo, ref)}
            >
              Open
            </button>
          </div>
        </>
      )}
      {!checking && !connection && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Read-only access to your repositories: pick any repository and branch to browse it as the project.
          </p>
          {canSignIn && (
            <div className="form">
              <button className="primary" disabled={!clientId.trim() || Boolean(device)} onClick={() => void signIn()}>
                Sign in with GitHub
              </button>
              <input
                placeholder="OAuth app client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                title="Client ID of a GitHub OAuth app with device flow enabled (Settings → Developer settings → OAuth Apps)"
              />
            </div>
          )}
          {device && (
            <p>
              Enter <b className="mono">{device.userCode}</b> at{' '}
              <a href={device.verificationUri} target="_blank" rel="noreferrer">
                {device.verificationUri}
              </a>{' '}
              — waiting…
            </p>
          )}
          <div className="form">
            <input
              type="password"
              autoComplete="off"
              placeholder="or paste a token (Contents: read-only)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button disabled={!token.trim()} onClick={() => void useToken(token)}>
              Use token
            </button>
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
              create one ↗
            </a>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {project.localAvailable ? (
              <>
                Or log in the GitHub CLI on this computer (<code>gh auth login</code>) and{' '}
                <button className="link" onClick={() => void connect()}>
                  check again
                </button>
                .
              </>
            ) : (
              <>
                With the local app (<code>sf fm dashboard</code>) running, its GitHub CLI login is used — no token
                needed.
              </>
            )}
          </p>
        </>
      )}
      {message && <p className="muted">{message}</p>}
    </div>
  );
}
