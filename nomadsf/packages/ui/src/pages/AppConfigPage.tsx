import { useEffect, useMemo, useState } from 'react';
import {
  CONFIG_TYPES,
  configFiles,
  configItems,
  configTypeLabel,
  deployConfigs,
  flattenConfig,
  setConfigValue,
  type ConfigFile,
  type ConfigItem,
} from '@nomadsf/core';
import { CodeEditor } from '../components/CodeEditor';
import { Select } from '../components/Select';
import { useStudio } from '../context';
import { Status } from '../statusLog';

/** Values Salesforce accepts for the settings that have a fixed list (shown as a dropdown when editing). */
export const SETTING_CHOICES: Record<string, string[]> = {
  ipRelaxation: ['ENFORCE', 'ENFORCE_ACTIVATED_DEVICES', 'BYPASS'],
  refreshTokenPolicy: ['infinite', 'immediately', 'zero', 'specific_lifetime'],
  ipRelaxationPolicyType: ['Enforce', 'EnforceActivatedDevices', 'Bypass'],
  permittedUsersPolicyType: ['AllSelfAuthorized', 'AdminApprovedPreAuthorized'],
  refreshTokenPolicyType: ['Infinite', 'Immediately', 'SpecificLifetime', 'ZeroTime'],
  refreshTokenValidityUnit: ['Hours', 'Days', 'Months'],
  requiredSessionLevel: ['STANDARD', 'HIGH_ASSURANCE'],
  calloutStatus: ['Enabled', 'Disabled'],
  namedCredentialType: ['SecuredEndpoint', 'PrivateEndpoint', 'Legacy'],
  authenticationProtocol: ['Custom', 'Oauth', 'AwsSv4', 'Jwt', 'JwtExchange', 'Basic', 'NoAuthentication'],
  principalType: ['NamedUser', 'PerUser', 'Anonymous'],
  protocol: ['Password', 'Oauth', 'Jwt', 'JwtExchange', 'AwsSv4', 'NoAuthentication'],
};
/** Settings that are never changed by hand: the key Salesforce gives, the app a part belongs to. */
const FIXED = /(consumerKey|oauthLink|orgScopedExternalApp|externalClientApplication|fullName)$/;

type Row = { key: string; file: ConfigFile; path: string; shown: string; value: string; list: boolean };

const rowsOf = (item: ConfigItem): Row[] =>
  item.files.flatMap((f) =>
    flattenConfig(f.xml).map((s) => {
      const leaf = s.path
        .split(' › ')
        .pop()!
        .replace(/\[.*\]$/, '');
      return {
        key: `${f.fullName}|${s.path}`,
        file: f,
        path: s.path,
        shown:
          item.files.length > 1 && f.type !== 'ExternalClientApplication'
            ? `${configTypeLabel(f.type)} › ${s.path}`
            : s.path,
        value: s.value,
        list: (f.xml.match(new RegExp(`<${leaf}>`, 'g')) ?? []).length > 1,
      };
    })
  );

/** The org's apps and credentials as configuration files, grouped (read once per org; `reload` after a deploy). */
export function useConfigItems(): { items: ConfigItem[] | null; error: string; reload: () => Promise<void> } {
  const { client } = useStudio();
  const [items, setItems] = useState<ConfigItem[] | null>(null);
  const [error, setError] = useState('');
  const reload = async () => {
    try {
      setItems(configItems(await configFiles(client, CONFIG_TYPES)));
      setError('');
    } catch (e) {
      setItems([]);
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setItems(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  return { items, error, reload };
}

/**
 * One app or credential defined in the org: every setting of its files in folding groups (one per part of an app),
 * changed in place or as a whole file, then deployed. Secrets are not in these files: they stay in Setup.
 */
export function ConfigItemView({ item, onDeployed }: { item: ConfigItem; onDeployed: () => Promise<void> }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [xmlOf, setXmlOf] = useState<string | null>(null);
  const [xmlText, setXmlText] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => rowsOf(item), [item]);
  const f = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !f || r.shown.toLowerCase().includes(f) || r.value.toLowerCase().includes(f));
  const changed = rows.filter((r) => edits[r.key] !== undefined && edits[r.key] !== r.value);
  // An app with parts: one folding group per part (OAuth settings, policies…), the app's own file first
  const groups = useMemo(() => {
    const out = new Map<string, Row[]>();
    for (const r of shown) {
      const part =
        r.file.type === 'ExternalClientApplication' || item.files.length < 2 ? 'The app' : configTypeLabel(r.file.type);
      out.set(part, [...(out.get(part) ?? []), r]);
    }
    return [...out.entries()];
  }, [shown, item]);

  const deploy = async (files: ConfigFile[], what: string) => {
    if (!(await confirmChange(`Deploy ${what} to ${org.label}.`))) return;
    setBusy(true);
    setStatus('Deploying…');
    try {
      await deployConfigs(client, files);
      logActivity('config-deploy', { item: item.name, files: files.map((x) => x.fullName) });
      setEditing(false);
      setEdits({});
      setXmlOf(null);
      await onDeployed();
      setStatus(`✓ Deployed ${what}.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const saveEdits = async () => {
    const files = new Map<string, ConfigFile>();
    try {
      for (const r of changed) {
        const base = files.get(r.file.fullName) ?? r.file;
        const value = edits[r.key];
        files.set(r.file.fullName, {
          ...base,
          xml: setConfigValue(base.xml, r.path, r.list ? value.split(/\s*,\s*/).filter(Boolean) : value),
        });
      }
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
      return;
    }
    await deploy([...files.values()], `${changed.length} change(s) to ${item.label}`);
  };

  const input = (r: Row) => {
    const leaf = r.path.split(' › ').pop()!;
    const value = edits[r.key] ?? r.value;
    const set = (v: string) => setEdits({ ...edits, [r.key]: v });
    if (FIXED.test(r.path)) return <span className="mono small">{r.value}</span>;
    if (r.value === 'true' || r.value === 'false')
      return <input type="checkbox" checked={value === 'true'} onChange={(e) => set(String(e.target.checked))} />;
    const choices = SETTING_CHOICES[leaf];
    if (choices)
      return (
        <Select value={value} onChange={(e) => set(e.target.value)}>
          {[...new Set([value, ...choices])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      );
    return <input className="config-input" value={value} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="config-view">
      <div className="form">
        {!editing && xmlOf === null && (
          <>
            <button className="primary" onClick={() => setEditing(true)}>
              Edit settings
            </button>
            <Select
              value=""
              onChange={(e) => {
                const file = item.files.find((x) => x.fullName === e.target.value);
                if (file) {
                  setXmlOf(file.fullName);
                  setXmlText(file.xml);
                }
              }}
            >
              <option value="">Edit a file…</option>
              {item.files.map((x) => (
                <option key={x.fullName} value={x.fullName}>
                  {configTypeLabel(x.type)} — {x.fullName}
                </option>
              ))}
            </Select>
          </>
        )}
        <Status text={status} />
      </div>
      {xmlOf !== null ? (
        <div className="config-xml">
          <p className="muted small">
            The whole file, as the Metadata API has it. Deploying it replaces the one in the org.
          </p>
          <CodeEditor value={xmlText} onChange={setXmlText} language="xml" height={420} />
          <div className="form">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                const file = item.files.find((x) => x.fullName === xmlOf)!;
                void deploy([{ ...file, xml: xmlText }], file.fullName);
              }}
            >
              Deploy…
            </button>
            <button onClick={() => setXmlOf(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="form">
            <input
              className="grow"
              placeholder="Filter settings and values"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {editing && (
              <>
                <button className="primary" disabled={busy || !changed.length} onClick={() => void saveEdits()}>
                  Deploy {changed.length || ''} change(s)…
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEdits({});
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
          {groups.map(([part, list]) => (
            <div key={part} className="config-group">
              {groups.length > 1 && (
                <button
                  className="config-group-head"
                  aria-expanded={!closed.has(part)}
                  onClick={() => {
                    const next = new Set(closed);
                    if (next.has(part)) next.delete(part);
                    else next.add(part);
                    setClosed(next);
                  }}
                >
                  <span className="tree-toggle">{closed.has(part) ? '▸' : '▾'}</span> {part}{' '}
                  <span className="muted small">({list.length})</span>
                </button>
              )}
              {!closed.has(part) && (
                <table className="config-table">
                  <tbody>
                    {list.map((r) => (
                      <tr
                        key={r.key}
                        className={edits[r.key] !== undefined && edits[r.key] !== r.value ? 'changed' : ''}
                      >
                        <td className="mono small">{r.path}</td>
                        <td>{editing ? input(r) : <span className="config-value">{r.value}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
