import { useEffect, useMemo, useState } from 'react';
import {
  describeMetadata,
  listMetadata,
  packageXml,
  retrieveZip,
  type MetadataComponent,
  type MetadataType,
  type RetrieveResult,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { useStudio } from '../context';

const keyOf = (c: Pick<MetadataComponent, 'type' | 'fullName'>): string => `${c.type}:${c.fullName}`;
const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

function save(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function base64ToBlob(base64: string, type: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

export function MetadataPage() {
  const { client, org, hostKind, logActivity } = useStudio();
  const [types, setTypes] = useState<MetadataType[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [type, setType] = useState('');
  const [components, setComponents] = useState<MetadataComponent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [basket, setBasket] = useState<Map<string, MetadataComponent>>(new Map());
  const [status, setStatus] = useState('');
  const [retrieved, setRetrieved] = useState<RetrieveResult | null>(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    void client.version().then(setVersion);
    describeMetadata(client)
      .then(setTypes)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client]);

  const shownTypes = useMemo(
    () => types.filter((t) => !typeFilter || t.xmlName.toLowerCase().includes(typeFilter.toLowerCase())),
    [types, typeFilter]
  );
  const current = types.find((t) => t.xmlName === type);

  const list = async (name: string) => {
    setType(name);
    setComponents([]);
    setSelected(new Set());
    setStatus(`Listing ${name}…`);
    try {
      const found = await listMetadata(client, name, types.find((t) => t.xmlName === name)?.inFolder);
      setComponents(found);
      setStatus(`${found.length} component(s).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const addToPackage = () => {
    const next = new Map(basket);
    for (const c of components) if (selected.has(keyOf(c))) next.set(keyOf(c), c);
    setBasket(next);
    setSelected(new Set());
  };
  const items = [...basket.values()];

  const downloadZip = async () => {
    setRetrieved(null);
    setStatus('Retrieving…');
    try {
      const r = await retrieveZip(client, items, { onProgress: (s) => setStatus(`Retrieve: ${s}…`) });
      setRetrieved(r);
      if (r.zipFile) save(`${org.label}-metadata-${stamp()}.zip`, base64ToBlob(r.zipFile, 'application/zip'));
      setStatus(r.errorMessage ? `❌ ${r.errorMessage}` : `Retrieved ${r.files.length} file(s).`);
      logActivity('metadata-download', { components: items.length, files: r.files.length });
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  // Local app only: `sf project retrieve start` into the repository the app runs in
  const retrieveIntoProject = async () => {
    setStatus('Retrieving into the project…');
    try {
      const res = await fetch('/api/org/retrieve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
        body: JSON.stringify({ org: org.id, members: items.map(keyOf) }),
      });
      const body = (await res.json()) as { files?: Array<Record<string, unknown>>; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? res.statusText);
      setRetrieved({
        id: '',
        status: 'Succeeded',
        files: (body.files ?? []) as unknown as MetadataComponent[],
        messages: [],
      });
      setStatus(`Retrieved ${body.files?.length ?? 0} file(s) into the project.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const xml = items.length ? packageXml(items, version) : '';

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Metadata</h2>
        <span className="muted">on {org.label}</span>
      </div>
      <div className="split">
        <div className="card section">
          <h3>Browse</h3>
          <div className="form">
            <input
              placeholder={`Filter ${types.length} types…`}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            />
            <select
              value={type}
              onChange={(e) => e.target.value && void list(e.target.value)}
              style={{ minWidth: 240 }}
            >
              <option value="">Choose a type…</option>
              {shownTypes.map((t) => (
                <option key={t.xmlName} value={t.xmlName}>
                  {t.xmlName}
                  {t.inFolder ? ' (folders)' : ''}
                </option>
              ))}
            </select>
            <button className="primary" disabled={selected.size === 0} onClick={addToPackage}>
              Add {selected.size || ''} to package
            </button>
          </div>
          {current && current.childXmlNames.length > 0 && (
            <p className="muted" style={{ margin: 0 }}>
              Child types: {current.childXmlNames.join(', ')}
            </p>
          )}
          <p className="muted" style={{ margin: 0 }}>
            {status}
          </p>
          {components.length > 0 && (
            <DataTable
              columns={['fullName', 'type', 'lastModifiedDate', 'lastModifiedByName', 'manageableState']}
              rows={components.map((c) => ({ ...c, key: keyOf(c) }))}
              rowKey="key"
              name={`${type}-components`}
              selected={selected}
              onSelectedChange={setSelected}
            />
          )}
        </div>

        <div className="card section">
          <h3>Package ({items.length})</h3>
          {items.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Select components on the left and add them; a package can mix types.
            </p>
          ) : (
            <>
              <div className="form">
                <button className="primary" onClick={() => void downloadZip()}>
                  Download zip
                </button>
                {hostKind === 'app' && (
                  <button onClick={() => void retrieveIntoProject()}>Retrieve into project</button>
                )}
                <button onClick={() => save('package.xml', new Blob([xml], { type: 'text/xml' }))}>package.xml</button>
                <button onClick={() => void navigator.clipboard.writeText(xml)}>Copy package.xml</button>
                <button onClick={() => setBasket(new Map())}>Clear</button>
              </div>
              <DataTable
                columns={['type', 'fullName']}
                rows={items.map((c) => ({ type: c.type, fullName: c.fullName, key: keyOf(c) }))}
                rowKey="key"
                name="package"
                onRowClick={(row) => {
                  const next = new Map(basket);
                  next.delete(String(row.key));
                  setBasket(next);
                }}
                note={<span>· click a row to remove it</span>}
              />
            </>
          )}
          {retrieved && (
            <div className="section">
              <h3>Retrieved files ({retrieved.files.length})</h3>
              {retrieved.messages.length > 0 && (
                <div className="error">{retrieved.messages.map((m) => `${m.fileName}: ${m.problem}`).join('\n')}</div>
              )}
              <DataTable
                columns={['fullName', 'type', 'fileName', 'filePath', 'state']}
                rows={retrieved.files as unknown as Array<Record<string, unknown>>}
                rowKey="__none"
                name="retrieved"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
