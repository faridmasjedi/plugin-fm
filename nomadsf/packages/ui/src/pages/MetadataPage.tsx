import { useEffect, useMemo, useState } from 'react';
import {
  parsePackageXml,
  describeMetadata,
  listMetadata,
  makeZip,
  packageXml,
  retrieveZip,
  type MetadataComponent,
  type MetadataType,
  type RetrieveResult,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { ComponentPreview } from '../components/MetadataSource';
import { useStudio } from '../context';
import { useProject } from '../project';
import { Status } from '../statusLog';

const keyOf = (c: Pick<MetadataComponent, 'type' | 'fullName'>): string => `${c.type}:${c.fullName}`;

type DeleteFile = 'destructiveChanges.xml' | 'destructiveChangesPre.xml' | 'destructiveChangesPost.xml';
const DELETE_FILES: Array<[DeleteFile, string]> = [
  ['destructiveChanges.xml', 'delete'],
  ['destructiveChangesPre.xml', 'delete before the deploy'],
  ['destructiveChangesPost.xml', 'delete after the deploy'],
];
const DELETE_FLAG: Record<DeleteFile, string> = {
  'destructiveChanges.xml': '--post-destructive-changes',
  'destructiveChangesPre.xml': '--pre-destructive-changes',
  'destructiveChangesPost.xml': '--post-destructive-changes',
};
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
  // A component clicked in Browse: its files, read-only
  const [preview, setPreview] = useState<MetadataComponent | null>(null);
  const [basket, setBasket] = useState<Map<string, MetadataComponent>>(new Map());
  // Components to delete from the org: destructiveChanges*.xml
  const [toDelete, setToDelete] = useState<Map<string, MetadataComponent>>(new Map());
  const [deleteFile, setDeleteFile] = useState<DeleteFile>('destructiveChanges.xml');
  const [status, setStatus] = useState('');
  const [retrieved, setRetrieved] = useState<RetrieveResult | null>(null);
  const [version, setVersion] = useState('');
  const project = useProject();

  // A manifest or a project type sent from the Project page: wildcards are expanded from the org
  useEffect(() => {
    const pending = project.pendingPackage;
    if (!pending || types.length === 0) return;
    project.openPackage(undefined);
    void (async () => {
      setStatus(`Loading ${pending.label}…`);
      const next = new Map(basket);
      try {
        for (const t of pending.types) {
          const members = t.members.includes('*')
            ? // eslint-disable-next-line no-await-in-loop
              (await listMetadata(client, t.type, types.find((x) => x.xmlName === t.type)?.inFolder)).filter(
                (c) => c.type === t.type
              )
            : t.members.map((fullName) => ({ type: t.type, fullName, fileName: '' }));
          for (const c of members) next.set(keyOf(c), c);
        }
        setBasket(next);
        setStatus(`Loaded ${pending.label} into the package.`);
      } catch (e) {
        setStatus(`❌ ${(e as Error).message}`);
      }
    })();
  }, [project.pendingPackage, types]);

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
    const deletes = new Map(toDelete);
    for (const c of components)
      if (selected.has(keyOf(c))) {
        next.set(keyOf(c), c);
        deletes.delete(keyOf(c));
      }
    setBasket(next);
    setToDelete(deletes);
    setSelected(new Set());
  };
  const addToDelete = () => {
    const next = new Map(toDelete);
    const kept = new Map(basket);
    for (const c of components)
      if (selected.has(keyOf(c))) {
        next.set(keyOf(c), c);
        kept.delete(keyOf(c));
      }
    setToDelete(next);
    setBasket(kept);
    setSelected(new Set());
  };
  const items = [...basket.values()];
  const deletes = [...toDelete.values()];

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

  // With only deletions, package.xml is empty (that is what Salesforce expects)
  const xml = items.length || deletes.length ? packageXml(items, version) : '';
  const destructiveXml = deletes.length ? packageXml(deletes, version) : '';
  const downloadManifests = () => {
    const zip = makeZip([
      { path: 'package.xml', content: xml },
      ...(deletes.length ? [{ path: deleteFile, content: destructiveXml }] : []),
    ]);
    save(`${org.label}-manifests-${stamp()}.zip`, new Blob([zip], { type: 'application/zip' }));
  };

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
              style={{ width: 280 }}
            />
            <select value={type} onChange={(e) => e.target.value && void list(e.target.value)} style={{ width: 280 }}>
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
            <button
              className="danger"
              disabled={selected.size === 0}
              title="Add to the components to delete from the org (destructiveChanges.xml)"
              onClick={addToDelete}
            >
              Add {selected.size || ''} to delete
            </button>
          </div>
          {selected.size > 0 && (
            <p className="muted selected-list" style={{ margin: 0 }}>
              Selected ({selected.size}):{' '}
              {components
                .filter((c) => selected.has(keyOf(c)))
                .map((c) => c.fullName)
                .join(', ')}
            </p>
          )}
          {current && current.childXmlNames.length > 0 && (
            <p className="muted" style={{ margin: 0 }}>
              Child types: {current.childXmlNames.join(', ')}
            </p>
          )}
          <Status text={status} block />
          {components.length > 0 && (
            <DataTable
              columns={['fullName', 'type', 'lastModifiedDate', 'lastModifiedByName', 'manageableState']}
              rows={components.map((c) => ({ ...c, key: keyOf(c) }))}
              rowKey="key"
              name={`${type}-components`}
              selected={selected}
              onSelectedChange={setSelected}
              onRowClick={(row) => setPreview(components.find((c) => keyOf(c) === row.key) ?? null)}
              note={<span>· tick to select · click a row to see what it is</span>}
            />
          )}
          {preview && (
            <ComponentPreview type={preview.type} fullName={preview.fullName} onClose={() => setPreview(null)} />
          )}
        </div>

        <div className="card section">
          <h3>
            Package ({items.length}){deletes.length > 0 && <span className="bad"> · delete ({deletes.length})</span>}
          </h3>
          {project.info && project.info.manifests.length > 0 && (
            <div className="form">
              <select
                value=""
                onChange={async (e) => {
                  const path = e.target.value;
                  const text = path ? await project.source?.fs.readText(path) : undefined;
                  if (text) project.openPackage({ label: path, types: parsePackageXml(text) });
                }}
              >
                <option value="">Load a manifest from {project.info.name}…</option>
                {project.info.manifests.map((m) => (
                  <option key={m.path} value={m.path}>
                    {m.path} ({m.members})
                  </option>
                ))}
              </select>
            </div>
          )}
          {items.length === 0 && deletes.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Select components on the left and add them to the package, or to delete from the org; a package can mix
              types.
            </p>
          ) : (
            <>
              <div className="form">
                <button className="primary" disabled={!items.length} onClick={() => void downloadZip()}>
                  Download zip
                </button>
                {hostKind === 'app' && (
                  <button onClick={() => void retrieveIntoProject()}>Retrieve into project</button>
                )}
                <button onClick={() => save('package.xml', new Blob([xml], { type: 'text/xml' }))}>package.xml</button>
                <button onClick={() => void navigator.clipboard.writeText(xml)}>Copy package.xml</button>
                <button
                  onClick={() => {
                    setBasket(new Map());
                    setToDelete(new Map());
                  }}
                >
                  Clear
                </button>
              </div>
              {items.length > 0 && (
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
              )}
              {deletes.length > 0 && (
                <div className="section delete-list">
                  <h3 className="bad">To delete from the org ({deletes.length})</h3>
                  <div className="form">
                    <label>
                      File
                      <select value={deleteFile} onChange={(e) => setDeleteFile(e.target.value as DeleteFile)}>
                        {DELETE_FILES.map(([file, hint]) => (
                          <option key={file} value={file}>
                            {file} — {hint}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button onClick={() => save(deleteFile, new Blob([destructiveXml], { type: 'text/xml' }))}>
                      {deleteFile}
                    </button>
                    <button onClick={() => void navigator.clipboard.writeText(destructiveXml)}>Copy</button>
                    <button className="primary" onClick={downloadManifests}>
                      Manifests (zip)
                    </button>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    Deploy with the CLI:{' '}
                    <code>
                      sf project deploy start --manifest package.xml {DELETE_FLAG[deleteFile]} {deleteFile}
                    </code>{' '}
                    (Release › Project deletes straight from here).
                  </p>
                  <DataTable
                    columns={['type', 'fullName']}
                    rows={deletes.map((c) => ({ type: c.type, fullName: c.fullName, key: keyOf(c) }))}
                    rowKey="key"
                    name="delete"
                    onRowClick={(row) => {
                      const next = new Map(toDelete);
                      next.delete(String(row.key));
                      setToDelete(next);
                    }}
                    note={<span>· click a row to remove it</span>}
                  />
                </div>
              )}
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
