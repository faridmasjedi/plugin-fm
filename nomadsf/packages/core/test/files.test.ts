import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  backupFileSource,
  backupFiles,
  backupFilesAt,
  capacityWarnings,
  copyFiles,
  createRecords,
  decryptBytes,
  encryptBytes,
  encryptedSink,
  fromBase64,
  loadRecords,
  memorySink,
  newBackupJob,
  newEncryption,
  orgFileSource,
  readManifest,
  runBackup,
  toBase64,
  unlockEncryption,
  type DataField,
  type HttpRequest,
} from '../src/index.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128, 7]);

describe('encryption', () => {
  it('encrypts with a passphrase and refuses a wrong one', async () => {
    const { info, key } = await newEncryption('correct horse battery');
    expect(info).toMatchObject({ algorithm: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations: 310_000 });
    const sealed = await encryptBytes(key, PNG);
    expect(new TextDecoder().decode(sealed.slice(0, 4))).toBe('NSE1');
    expect([...(await decryptBytes(key, sealed))]).toEqual([...PNG]);
    // Same data, new IV: different bytes
    expect(toBase64(await encryptBytes(key, PNG))).not.toBe(toBase64(sealed));
    const again = await unlockEncryption(info, 'correct horse battery');
    expect([...(await decryptBytes(again, sealed))]).toEqual([...PNG]);
    await expect(unlockEncryption(info, 'wrong passphrase')).rejects.toThrow('Wrong passphrase');
    await expect(newEncryption('short')).rejects.toThrow('at least 8');
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptBytes(key, tampered)).rejects.toThrow('changed');
  });

  it('wraps a sink: data files encrypted as .enc, the list of runs plain', async () => {
    const { key } = await newEncryption('correct horse battery');
    const inner = memorySink();
    const sink = encryptedSink(inner, key);
    await sink.write('job/run/Account/part-0001.csv', 'Id,Name\n001,Acme\n');
    await sink.writeBytes('job/run/_files/content/069/068', PNG);
    await sink.write('job/backups.json', '{"runs":[]}');
    expect([...inner.files.keys()].sort()).toEqual([
      'job/backups.json',
      'job/run/Account/part-0001.csv.enc',
      'job/run/_files/content/069/068.enc',
    ]);
    expect(String(inner.files.get('job/backups.json'))).toBe('{"runs":[]}');
    expect(new TextDecoder().decode(inner.files.get('job/run/Account/part-0001.csv.enc') as Uint8Array)).not.toContain(
      'Acme'
    );
    expect(await sink.read('job/run/Account/part-0001.csv')).toBe('Id,Name\n001,Acme\n');
    expect([...((await sink.readBytes('job/run/_files/content/069/068')) ?? [])]).toEqual([...PNG]);
    expect(await sink.list('job/run/Account')).toEqual(['part-0001.csv']);
    expect(await sink.read('job/run/missing.csv')).toBeUndefined();
  });
});

/** A fake org with records, files (ContentVersion / ContentDocumentLink) and attachments. */
function fileOrg(prefix: string, seed: { files?: boolean } = {}) {
  type Rec = Record<string, unknown> & { type: string };
  const records = new Map<string, Rec>();
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const id = (p: string) => `${p}${prefix}${String(++n).padStart(11, '0')}AAA`;
  if (seed.files) {
    records.set('001S00000000001AAA', { type: 'Account', Id: '001S00000000001AAA', Name: 'Acme' });
    records.set('001S00000000002AAA', { type: 'Account', Id: '001S00000000002AAA', Name: 'Globex' });
    records.set('069S00000000001AAA', { type: 'ContentDocument', Id: '069S00000000001AAA' });
    records.set('068S00000000001AAA', {
      type: 'ContentVersion',
      Id: '068S00000000001AAA',
      ContentDocumentId: '069S00000000001AAA',
      Title: 'Logo',
      PathOnClient: 'logo.png',
      FileExtension: 'png',
      ContentSize: String(PNG.length),
      VersionNumber: '1',
      IsLatest: true,
      SystemModstamp: '2026-10-19T00:00:00.000Z',
    });
    blobs.set('068S00000000001AAA', PNG);
    records.set('068S00000000002AAA', {
      type: 'ContentVersion',
      Id: '068S00000000002AAA',
      ContentDocumentId: '069S00000000002AAA',
      Title: 'Huge video',
      PathOnClient: 'huge.mp4',
      FileExtension: 'mp4',
      ContentSize: String(500 * 1024 * 1024),
      VersionNumber: '1',
      IsLatest: true,
    });
    for (const [doc, entity, share] of [
      ['069S00000000001AAA', '001S00000000001AAA', 'V'],
      ['069S00000000001AAA', '001S00000000002AAA', 'C'],
      ['069S00000000002AAA', '001S00000000001AAA', 'V'],
    ])
      records.set(`06A${doc}${entity}`, {
        type: 'ContentDocumentLink',
        ContentDocumentId: doc,
        LinkedEntityId: entity,
        ShareType: share,
        Visibility: 'AllUsers',
      });
    records.set('00PS00000000001AAA', {
      type: 'Attachment',
      Id: '00PS00000000001AAA',
      ParentId: '001S00000000002AAA',
      Name: 'contract.pdf',
      ContentType: 'application/pdf',
      BodyLength: '3',
      IsPrivate: false,
    });
    blobs.set('00PS00000000001AAA', bytes('PDF'));
  }
  const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  const calls: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = decodeURIComponent(r.path).replace(/\+/g, ' ');
    const blob = /\/sobjects\/(ContentVersion|Attachment)\/(\w+)\/(VersionData|Body)$/.exec(path);
    if (blob) {
      calls.push(`blob ${blob[2]}`);
      return { status: 200, headers: {}, body: '', bodyBase64: toBase64(blobs.get(blob[2]) ?? new Uint8Array()) };
    }
    if (path.includes('/query?q=')) {
      const soql = path.split('q=')[1];
      const type = /FROM (\w+)/.exec(soql)![1];
      const fields = /SELECT (.+?) FROM/.exec(soql)![1].split(', ');
      const ins = [...soql.matchAll(/(\w+) IN \(([^)]*)\)/g)].map(
        (m) => [m[1], m[2].split(',').map((x) => x.replace(/'/g, ''))] as const
      );
      const eq = /WHERE Id = '(\w+)'/.exec(soql);
      const since = /SystemModstamp > (\S+)/.exec(soql);
      const rows = [...records.values()].filter(
        (x) =>
          x.type === type &&
          ins.every(([f, vals]) => vals.includes(String(x[f]))) &&
          (!eq || x.Id === eq[1]) &&
          (!soql.includes('IsLatest = true') || x.IsLatest !== false) &&
          (!since || String(x.SystemModstamp ?? '') > since[1])
      );
      return json({
        totalSize: rows.length,
        done: true,
        records: rows.map((x) => Object.fromEntries([['attributes', {}], ...fields.map((f) => [f, x[f] ?? null])])),
      });
    }
    if (r.method === 'POST' && path.endsWith('/sobjects/ContentVersion')) {
      const b = JSON.parse(r.body ?? '{}') as Record<string, string>;
      const version = id('068');
      const doc = id('069');
      records.set(version, {
        type: 'ContentVersion',
        Id: version,
        ContentDocumentId: doc,
        Title: b.Title,
        PathOnClient: b.PathOnClient,
        IsLatest: true,
      });
      blobs.set(version, fromBase64(b.VersionData));
      records.set(`06A${doc}${b.FirstPublishLocationId}`, {
        type: 'ContentDocumentLink',
        ContentDocumentId: doc,
        LinkedEntityId: b.FirstPublishLocationId,
        ShareType: 'I',
      });
      calls.push(`upload ${b.Title}`);
      return json({ id: version, success: true });
    }
    if (r.method === 'POST' && path.endsWith('/sobjects/ContentDocumentLink')) {
      const b = JSON.parse(r.body ?? '{}') as Record<string, string>;
      const key = `06A${b.ContentDocumentId}${b.LinkedEntityId}`;
      if (records.has(key))
        return {
          status: 400,
          headers: {},
          body: JSON.stringify([
            { message: 'Document with ID: x is already linked with the entity', errorCode: 'DUPLICATE_VALUE' },
          ]),
        };
      records.set(key, { type: 'ContentDocumentLink', ...b });
      calls.push(`link ${b.LinkedEntityId} ${b.ShareType}`);
      return json({ id: id('06A'), success: true });
    }
    if (r.method === 'POST' && path.endsWith('/sobjects/Attachment')) {
      const b = JSON.parse(r.body ?? '{}') as Record<string, string>;
      const att = id('00P');
      records.set(att, { type: 'Attachment', Id: att, ParentId: b.ParentId, Name: b.Name });
      blobs.set(att, fromBase64(b.Body));
      calls.push(`attachment ${b.Name} on ${b.ParentId}`);
      return json({ id: att, success: true });
    }
    return { status: 404, headers: {}, body: '[]' };
  }, '62.0');
  return { client, records, blobs, calls };
}

describe('files and attachments', () => {
  const choice = { files: true, attachments: true, maxMB: 50 };

  it('backs up files and attachments of the records, skipping the too large ones', async () => {
    const org = fileOrg('S', { files: true });
    const sink = memorySink();
    const result = await backupFiles(org.client, sink, 'job/r1', ['001S00000000001AAA', '001S00000000002AAA'], {
      choice,
      prefixes: new Set(['001']),
    });
    expect(result).toMatchObject({ versions: 1, links: 3, attachments: 1, bytes: PNG.length + 3 });
    expect(result.skipped).toEqual([{ id: '069S00000000002AAA', name: 'Huge video', reason: 'larger than 50 MB' }]);
    expect([...((await sink.readBytes('job/r1/_files/content/069S00000000001AAA/068S00000000001AAA')) ?? [])]).toEqual([
      ...PNG,
    ]);
    expect(await sink.read('job/r1/_files/ContentDocumentLink.csv')).toContain('001S00000000002AAA,C,AllUsers');
    const files = await backupFilesAt(sink, 'job', ['r1']);
    expect(files.versions.get('069S00000000001AAA')).toMatchObject({ Title: 'Logo', run: 'r1' });
    expect(files.attachments.get('00PS00000000001AAA')).toMatchObject({ Name: 'contract.pdf' });
  });

  it('copies files from the backup to the new records, links shared ones, and skips them on a re-run', async () => {
    const source = fileOrg('S', { files: true });
    const sink = memorySink();
    await backupFiles(source.client, sink, 'job/r1', ['001S00000000001AAA', '001S00000000002AAA'], {
      choice,
      prefixes: new Set(['001']),
    });
    const files = await backupFilesAt(sink, 'job', ['r1']);
    const target = fileOrg('T');
    const ids = { '001S00000000001AAA': '001T00000000001AAA', '001S00000000002AAA': '001T00000000002AAA' };
    const result = await copyFiles(backupFileSource(sink, 'job', files), target.client, ids, { choice });
    expect(result).toMatchObject({ files: 1, links: 1, attachments: 1, failures: [] });
    expect(result.skipped[0]).toMatchObject({
      name: 'Huge video',
      reason: 'not in the backup (too large when it was backed up)',
    });
    expect(target.calls).toEqual([
      'upload Logo',
      'link 001T00000000002AAA C',
      'attachment contract.pdf on 001T00000000002AAA',
    ]);
    const newVersion = [...target.records.values()].find((r) => r.type === 'ContentVersion')!;
    expect([...target.blobs.get(String(newVersion.Id))!]).toEqual([...PNG]);
    expect(result.created.map((c) => c.object)).toEqual(['Attachment', 'ContentDocument']);
    // Re-run with what was copied: nothing uploaded again; existing links are not an error
    const again = await copyFiles(backupFileSource(sink, 'job', files), target.client, ids, {
      choice,
      known: result.ids,
    });
    expect(again).toMatchObject({ files: 0, attachments: 0, failures: [] });
  });

  it('copies straight from an org too', async () => {
    const source = fileOrg('S', { files: true });
    const target = fileOrg('T');
    const result = await copyFiles(
      orgFileSource(source.client),
      target.client,
      { '001S00000000002AAA': '001T00000000009AAA' },
      { choice }
    );
    expect(result).toMatchObject({ files: 1, attachments: 1 });
    expect(target.calls).toEqual(['upload Logo', 'attachment contract.pdf on 001T00000000009AAA']);
  });
});

describe('backup runs with files, encrypted', () => {
  it('writes an encrypted run with its files that reads back with the key', async () => {
    const org = fileOrg('S', { files: true });
    const base = org.client;
    // The org answers the backup's own calls too
    const field = (name: string, type = 'string'): DataField => ({
      name,
      label: name,
      type,
      referenceTo: [],
      createable: true,
      updateable: true,
      calculated: false,
      externalId: false,
      nillable: true,
      defaultedOnCreate: false,
      unique: false,
    });
    const client = new SalesforceClient(async (r: HttpRequest) => {
      const path = decodeURIComponent(r.path);
      const json = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) });
      if (path.endsWith('/sobjects'))
        return json({
          sobjects: [
            {
              name: 'Account',
              label: 'Account',
              custom: false,
              queryable: true,
              createable: true,
              replicateable: true,
              keyPrefix: '001',
            },
          ],
        });
      if (path.endsWith('/sobjects/Account/describe'))
        return json({ fields: [field('Id', 'id'), field('Name'), field('SystemModstamp', 'datetime')] });
      if (path.includes('FROM Organization'))
        return json({
          totalSize: 1,
          done: true,
          records: [{ attributes: {}, Id: '00DS', Name: 'Acme', IsSandbox: true }],
        });
      if (path.endsWith('/jobs/query')) return json({ id: '750S', state: 'UploadComplete' });
      if (path.endsWith('/jobs/query/750S')) return json({ id: '750S', state: 'JobComplete' });
      if (path.includes('/jobs/query/750S/results'))
        return {
          status: 200,
          headers: { 'sforce-numberofrecords': '2', 'sforce-locator': 'null' },
          body: '"Id","SystemModstamp","Name"\n"001S00000000001AAA","2026","Acme"\n"001S00000000002AAA","2026","Globex"\n',
        };
      return (base as unknown as { transport: (q: HttpRequest) => Promise<unknown> }).transport(r) as never;
    }, '62.0');
    const { info, key } = await newEncryption('correct horse battery');
    const inner = memorySink();
    const sink = encryptedSink(inner, key);
    const job = {
      ...newBackupJob('acme'),
      id: 'b1',
      name: 'Files',
      scope: 'picked' as const,
      objects: [{ name: 'Account' }],
      files: { files: true, attachments: true, maxMB: 50 },
      encryption: info,
    };
    const manifest = await runBackup(client, job, sink, { now: new Date('2026-10-19T02:00:00Z') });
    expect(manifest.files).toMatchObject({ versions: 1, attachments: 1 });
    expect(manifest.encrypted).toBe(true);
    const names = [...inner.files.keys()];
    expect(names.filter((n) => !n.endsWith('.enc'))).toEqual(['Files-b1/backups.json']);
    expect(names).toContain('Files-b1/2026-10-19T02-00-00Z/_files/content/069S00000000001AAA/068S00000000001AAA.enc');
    // Read back with the key (the restore path)
    expect((await readManifest(sink, 'Files-b1/2026-10-19T02-00-00Z'))?.files?.versions).toBe(1);
    const files = await backupFilesAt(sink, 'Files-b1', ['2026-10-19T02-00-00Z']);
    expect(files.versions.size).toBe(2);
    expect([...files.versions.values()].filter((v) => v.file).map((v) => v.Title)).toEqual(['Logo']);
    // Without the key, the data is unreadable
    expect(await inner.read('Files-b1/2026-10-19T02-00-00Z/manifest.json')).toBeUndefined();
  });
});

describe('large loads', () => {
  it('sends batches in parallel, keeps results in order, and hands over the Id map as it goes', async () => {
    let inFlight = 0;
    let most = 0;
    let n = 0;
    const client = new SalesforceClient(async (r: HttpRequest) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((ok) => setTimeout(ok, 5 + Math.random() * 10));
      inFlight--;
      const body = JSON.parse(r.body ?? '{}') as { records: Array<{ Name: string }> };
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          body.records.map((x) => ({ id: `001N${String(++n).padStart(11, '0')}AAA`, success: true, name: x.Name }))
        ),
      };
    }, '62.0');
    const records = Array.from({ length: 2000 }, (_, i) => ({ Name: `A${i}` }));
    const results = await createRecords(client, 'Account', records);
    expect(most).toBeGreaterThan(1);
    expect(results.map((x) => (x as unknown as { name: string }).name)).toEqual(records.map((x) => x.Name));

    const field = (name: string, type = 'string'): DataField => ({
      name,
      label: name,
      type,
      referenceTo: [],
      createable: true,
      updateable: true,
      calculated: false,
      externalId: false,
      nillable: true,
      defaultedOnCreate: false,
      unique: false,
    });
    const schema = [field('Id', 'id'), field('Name')];
    const saves: number[] = [];
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      Id: `001S${String(i).padStart(11, '0')}AAA`,
      Name: `A${i}`,
    }));
    const result = await loadRecords(
      client,
      [{ name: 'Account', source: schema, target: schema }],
      { Account: rows },
      {
        maps: { users: new Map(), recordTypes: new Map(), queues: new Map() },
        onIds: (ids) => void saves.push(Object.keys(ids).length),
      }
    );
    expect(result.objects[0].created).toBe(12_000);
    // Saved twice while loading (every 5,000) and once at the end of the object
    expect(saves.length).toBeGreaterThanOrEqual(3);
    expect(saves.at(-1)).toBe(12_000);
  });

  it('warns when the target is short of storage or API calls, and suggests Bulk for large copies', () => {
    const capacity = {
      api: { max: 100_000, remaining: 1_000 },
      dataMB: { max: 200, remaining: 50 },
      fileMB: { max: 200, remaining: 10 },
    };
    const warnings = capacityWarnings(capacity, {
      records: 60_000,
      fileBytes: 30 * 1024 * 1024,
      bulk: false,
      files: 40,
    });
    expect(warnings.join('\n')).toContain('Data storage: the copy needs about 118 MB');
    expect(warnings.join('\n')).toContain('File storage');
    expect(warnings.join('\n')).toContain('API calls');
    expect(warnings.join('\n')).toContain('Large copy');
    expect(
      capacityWarnings({ dataMB: { max: 1000, remaining: 900 } }, { records: 100, fileBytes: 0, bulk: true })
    ).toEqual([]);
  });
});
