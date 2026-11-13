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
import { DataTable } from '../components/DataTable';
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

/**
 * Org › Apps & credentials: the connected apps and external client apps defined in this org, and its named and external
 * credentials — every setting of their files, to read and change (one value at a time, or the whole file), then
 * deploy. Secrets are not in these files: client secrets, passwords and keys stay in Setup.
 */
export function AppConfigPage({ onOpen }: { onOpen?: (tool: string) => void }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [items, setItems] = useState<ConfigItem[] | null>(null);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [xmlOf, setXmlOf] = useState<string | null>(null);
  const [xmlText, setXmlText] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (quiet = false) => {
    setItems(null);
    if (!quiet) setStatus(`Reading the apps and credentials of ${org.label}…`);
    try {
      setItems(configItems(await configFiles(client, CONFIG_TYPES)));
      if (!quiet) setStatus('');
    } catch (e) {
      setItems([]);
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setName('');
    setEditing(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const item = items?.find((i) => `${i.kind}:${i.name}` === name);
  const rows = useMemo(() => (item ? rowsOf(item) : []), [item]);
  const f = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !f || r.shown.toLowerCase().includes(f) || r.value.toLowerCase().includes(f));
  const changed = rows.filter((r) => edits[r.key] !== undefined && edits[r.key] !== r.value);

  const open = (key: string) => {
    setName(key);
    setEditing(false);
    setEdits({});
    setXmlOf(null);
  };

  const deploy = async (files: ConfigFile[], what: string) => {
    if (!(await confirmChange(`Deploy ${what} to ${org.label}.`))) return;
    setBusy(true);
    setStatus('Deploying…');
    try {
      await deployConfigs(client, files);
      logActivity('config-deploy', { item: item?.name, files: files.map((x) => x.fullName) });
      setStatus(`✓ Deployed ${what}.`);
      setEditing(false);
      setEdits({});
      setXmlOf(null);
      const keep = name;
      await load(true);
      setName(keep);
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
    await deploy([...files.values()], `${changed.length} change(s) to ${item?.label}`);
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
    <div className="page">
      <div className="toolbar">
        <h2>Apps & credentials</h2>
        <span className="muted">
          Connected apps, external client apps, named and external credentials of {org.label}: every setting, to read
          and change
        </span>
        <span className="grow" />
        <button onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
      {status && <Status text={status} block />}
      {items && (
        <div className="card section">
          {items.length ? (
            <DataTable
              name="apps-credentials"
              columns={['kind', 'label', 'name', 'parts']}
              rows={items.map((i) => ({
                Id: `${i.kind}:${i.name}`,
                kind: i.kind,
                label: i.label,
                name: i.name,
                parts: i.files.length > 1 ? i.files.length : '',
              }))}
              onRowClick={(r) => open(String(r.Id))}
              selectedKey={name}
            />
          ) : (
            <p className="muted">No connected app, external client app or credential is defined in {org.label}.</p>
          )}
          <p className="muted small">
            Apps from Salesforce or installed packages (Salesforce CLI, Workbench…) are used here but defined elsewhere:
            their policies are in{' '}
            <button className="link" onClick={() => onOpen?.('apps')}>
              Org › Connected apps
            </button>
            . Secrets (client secrets, passwords, private keys) are never read or written: they stay in Setup.
          </p>
        </div>
      )}
      {item && (
        <div className="card section">
          <div className="form">
            <span className="pill">{item.kind}</span>
            <b>{item.label}</b>
            <span className="muted mono small">{item.name}</span>
            <span className="grow" />
            {!editing && xmlOf === null && (
              <button className="primary" onClick={() => setEditing(true)}>
                Edit settings
              </button>
            )}
            {xmlOf === null && !editing && (
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
            )}
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
                    void deploy([{ ...file, xml: xmlText }], `${file.fullName}`);
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
              <table className="config-table">
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.key} className={edits[r.key] !== undefined && edits[r.key] !== r.value ? 'changed' : ''}>
                      <td className="mono small">{r.shown}</td>
                      <td>{editing ? input(r) : <span className="config-value">{r.value}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
