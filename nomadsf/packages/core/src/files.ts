import type { BackupSink } from './backup.js';
import type { SalesforceClient } from './client.js';
import { parseCsv, toCsv } from './csv.js';
import { query } from './query.js';
import { toBase64 } from './zip.js';

/**
 * Salesforce Files (ContentVersion / ContentDocument / ContentDocumentLink) and classic
 * Attachments of the records being backed up, restored or copied. A backup keeps each file's
 * latest version as bytes under `_files/`, with CSVs of the versions, the links (which record
 * each file belongs to, how it is shared) and the attachments. Copying uploads them again in
 * the target and links them to the new records.
 */

export type FilesChoice = {
  /** Salesforce Files linked to the records. */
  files: boolean;
  /** Classic attachments of the records. */
  attachments: boolean;
  /** Files larger than this are listed as skipped. */
  maxMB: number;
};

export type FileVersion = {
  Id: string;
  ContentDocumentId: string;
  Title: string;
  PathOnClient: string;
  FileExtension: string;
  ContentSize: string;
  VersionNumber: string;
  Description: string;
  /** Path of the bytes in the backup (relative to the run). */
  file?: string;
};
export type FileLink = { ContentDocumentId: string; LinkedEntityId: string; ShareType: string; Visibility: string };
export type AttachmentRow = {
  Id: string;
  ParentId: string;
  Name: string;
  ContentType: string;
  BodyLength: string;
  Description: string;
  IsPrivate: string;
  file?: string;
};
export type Skipped = { id: string; name: string; reason: string };
export type FilesResult = { versions: number; links: number; attachments: number; bytes: number; skipped: Skipped[] };

const ID = /^[a-zA-Z0-9]{15,18}$/;
const MB = 1024 * 1024;
/** Salesforce accepts base64 file data up to about 37 MB in a JSON request; larger needs a multipart upload. */
export const MAX_UPLOAD_MB = 35;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const asRows = <T>(rows: Array<Record<string, unknown>>, columns: string[]): T[] =>
  rows.map((r) => Object.fromEntries(columns.map((c) => [c, text(r[c])])) as T);

/** Runs `soql(list)` for the Ids in chunks of 200 and joins the rows. */
async function byIds(
  client: SalesforceClient,
  ids: string[],
  soql: (list: string) => string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const valid = [...new Set(ids.filter((id) => ID.test(id)))];
  for (let i = 0; i < valid.length; i += 200) {
    const list = valid
      .slice(i, i + 200)
      .map((id) => `'${id}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await query(client, soql(list), { maxRows: 50_000 })).rows);
  }
  return out;
}

const LINK_FIELDS = ['ContentDocumentId', 'LinkedEntityId', 'ShareType', 'Visibility'];
const VERSION_FIELDS = [
  'Id',
  'ContentDocumentId',
  'Title',
  'PathOnClient',
  'FileExtension',
  'ContentSize',
  'VersionNumber',
  'Description',
];
const ATTACHMENT_FIELDS = ['Id', 'ParentId', 'Name', 'ContentType', 'BodyLength', 'Description', 'IsPrivate'];

export async function fileLinksOf(client: SalesforceClient, recordIds: string[]): Promise<FileLink[]> {
  return asRows<FileLink>(
    await byIds(
      client,
      recordIds,
      (list) => `SELECT ${LINK_FIELDS.join(', ')} FROM ContentDocumentLink WHERE LinkedEntityId IN (${list})`
    ),
    LINK_FIELDS
  );
}

/** Links of files changed since a moment, to records of the given key prefixes (incremental backups). */
export async function changedFileLinks(
  client: SalesforceClient,
  since: string,
  prefixes: Set<string>
): Promise<FileLink[]> {
  const changed = await query(
    client,
    `SELECT ContentDocumentId FROM ContentVersion WHERE IsLatest = true AND SystemModstamp > ${since}`,
    {
      maxRows: 100_000,
    }
  );
  const docs = changed.rows.map((r) => text(r.ContentDocumentId));
  const links = asRows<FileLink>(
    await byIds(
      client,
      docs,
      (list) => `SELECT ${LINK_FIELDS.join(', ')} FROM ContentDocumentLink WHERE ContentDocumentId IN (${list})`
    ),
    LINK_FIELDS
  );
  return links.filter((l) => prefixes.has(l.LinkedEntityId.slice(0, 3)));
}

export async function latestVersions(client: SalesforceClient, documentIds: string[]): Promise<FileVersion[]> {
  return asRows<FileVersion>(
    await byIds(
      client,
      documentIds,
      (list) =>
        `SELECT ${VERSION_FIELDS.join(
          ', '
        )} FROM ContentVersion WHERE IsLatest = true AND ContentDocumentId IN (${list})`
    ),
    VERSION_FIELDS
  );
}

export async function attachmentsOf(client: SalesforceClient, parentIds: string[]): Promise<AttachmentRow[]> {
  return asRows<AttachmentRow>(
    await byIds(
      client,
      parentIds,
      (list) => `SELECT ${ATTACHMENT_FIELDS.join(', ')} FROM Attachment WHERE ParentId IN (${list})`
    ),
    ATTACHMENT_FIELDS
  );
}

export async function changedAttachments(
  client: SalesforceClient,
  since: string,
  prefixes: Set<string>
): Promise<AttachmentRow[]> {
  const rows = await query(
    client,
    `SELECT ${ATTACHMENT_FIELDS.join(', ')} FROM Attachment WHERE SystemModstamp > ${since}`,
    {
      maxRows: 100_000,
    }
  );
  return asRows<AttachmentRow>(rows.rows, ATTACHMENT_FIELDS).filter((a) => prefixes.has(a.ParentId.slice(0, 3)));
}

const uniqueBy = <T>(list: T[], key: (x: T) => string): T[] => [...new Map(list.map((x) => [key(x), x])).values()];

/**
 * Backs up the files and attachments of the records (and, for incremental runs, those changed
 * since) into `<base>/_files/`.
 */
export async function backupFiles(
  client: SalesforceClient,
  sink: BackupSink,
  base: string,
  recordIds: string[],
  options: { choice: FilesChoice; since?: string; prefixes: Set<string>; onProgress?: (text: string) => void }
): Promise<FilesResult> {
  const { choice } = options;
  const result: FilesResult = { versions: 0, links: 0, attachments: 0, bytes: 0, skipped: [] };
  const limit = choice.maxMB * MB;
  if (choice.files) {
    options.onProgress?.('Finding the files of the records…');
    let links = await fileLinksOf(client, recordIds);
    if (options.since) links = [...links, ...(await changedFileLinks(client, options.since, options.prefixes))];
    links = uniqueBy(links, (l) => `${l.ContentDocumentId}:${l.LinkedEntityId}`);
    const versions = await latestVersions(
      client,
      links.map((l) => l.ContentDocumentId)
    );
    for (const [i, v] of versions.entries()) {
      if (Number(v.ContentSize) > limit) {
        result.skipped.push({ id: v.ContentDocumentId, name: v.Title, reason: `larger than ${choice.maxMB} MB` });
        continue;
      }
      options.onProgress?.(`Files ${i + 1}/${versions.length}: ${v.Title}`);
      /* eslint-disable no-await-in-loop */
      const data = await client.blob(`/sobjects/ContentVersion/${v.Id}/VersionData`);
      v.file = `_files/content/${v.ContentDocumentId}/${v.Id}`;
      await sink.writeBytes(`${base}/${v.file}`, data);
      /* eslint-enable no-await-in-loop */
      result.bytes += data.length;
      result.versions++;
    }
    await sink.write(`${base}/_files/ContentVersion.csv`, toCsv([...VERSION_FIELDS, 'file'], versions));
    await sink.write(`${base}/_files/ContentDocumentLink.csv`, toCsv(LINK_FIELDS, links));
    result.links = links.length;
  }
  if (choice.attachments) {
    options.onProgress?.('Finding the attachments of the records…');
    let list = await attachmentsOf(client, recordIds);
    if (options.since)
      list = uniqueBy([...list, ...(await changedAttachments(client, options.since, options.prefixes))], (a) => a.Id);
    for (const [i, a] of list.entries()) {
      if (Number(a.BodyLength) > limit) {
        result.skipped.push({ id: a.Id, name: a.Name, reason: `larger than ${choice.maxMB} MB` });
        continue;
      }
      options.onProgress?.(`Attachments ${i + 1}/${list.length}: ${a.Name}`);
      /* eslint-disable no-await-in-loop */
      const data = await client.blob(`/sobjects/Attachment/${a.Id}/Body`);
      a.file = `_files/attachments/${a.Id}`;
      await sink.writeBytes(`${base}/${a.file}`, data);
      /* eslint-enable no-await-in-loop */
      result.bytes += data.length;
      result.attachments++;
    }
    await sink.write(`${base}/_files/Attachment.csv`, toCsv([...ATTACHMENT_FIELDS, 'file'], list));
  }
  return result;
}

// ---------- reading files back from a backup ----------

export type BackupFiles = {
  /** ContentDocumentId -> latest version in the backup, with the run folder its bytes are in. */
  versions: Map<string, FileVersion & { run: string }>;
  links: FileLink[];
  attachments: Map<string, AttachmentRow & { run: string }>;
};

/** Files and attachments as they were at the run (later runs win). `runs` are the run folders, oldest first. */
export async function backupFilesAt(sink: BackupSink, root: string, runs: string[]): Promise<BackupFiles> {
  const out: BackupFiles = { versions: new Map(), links: [], attachments: new Map() };
  for (const run of runs) {
    /* eslint-disable no-await-in-loop */
    const versions = await sink.read(`${root}/${run}/_files/ContentVersion.csv`);
    const links = await sink.read(`${root}/${run}/_files/ContentDocumentLink.csv`);
    const attachments = await sink.read(`${root}/${run}/_files/Attachment.csv`);
    /* eslint-enable no-await-in-loop */
    // Versions without bytes (too large when backed up) are kept, so a copy can say why they are missing
    for (const v of versions ? (parseCsv(versions).rows as unknown as FileVersion[]) : [])
      if (v.file || !out.versions.get(v.ContentDocumentId)?.file) out.versions.set(v.ContentDocumentId, { ...v, run });
    if (links) out.links.push(...(parseCsv(links).rows as unknown as FileLink[]));
    for (const a of attachments ? (parseCsv(attachments).rows as unknown as AttachmentRow[]) : [])
      if (a.file) out.attachments.set(a.Id, { ...a, run });
  }
  out.links = uniqueBy(out.links, (l) => `${l.ContentDocumentId}:${l.LinkedEntityId}`);
  return out;
}

// ---------- copying files into an org ----------

/** Where files come from when copying: an org, or a backup. */
export type FileSource = {
  links(recordIds: string[]): Promise<FileLink[]>;
  versions(documentIds: string[]): Promise<FileVersion[]>;
  data(version: FileVersion): Promise<Uint8Array | undefined>;
  attachments(parentIds: string[]): Promise<AttachmentRow[]>;
  attachmentBody(attachment: AttachmentRow): Promise<Uint8Array | undefined>;
};

export function orgFileSource(client: SalesforceClient): FileSource {
  return {
    links: (ids) => fileLinksOf(client, ids),
    versions: (docs) => latestVersions(client, docs),
    data: (v) => client.blob(`/sobjects/ContentVersion/${v.Id}/VersionData`),
    attachments: (ids) => attachmentsOf(client, ids),
    attachmentBody: (a) => client.blob(`/sobjects/Attachment/${a.Id}/Body`),
  };
}

export function backupFileSource(sink: BackupSink, root: string, files: BackupFiles): FileSource {
  const k15 = (id: string): string => id.slice(0, 15);
  return {
    async links(ids) {
      const wanted = new Set(ids.map(k15));
      return files.links.filter((l) => wanted.has(k15(l.LinkedEntityId)));
    },
    async versions(docs) {
      return docs.map((d) => files.versions.get(d)).filter((v): v is FileVersion & { run: string } => Boolean(v));
    },
    async data(v) {
      const run = (v as FileVersion & { run?: string }).run ?? files.versions.get(v.ContentDocumentId)?.run;
      return v.file && run ? sink.readBytes(`${root}/${run}/${v.file}`) : undefined;
    },
    async attachments(ids) {
      const wanted = new Set(ids.map(k15));
      return [...files.attachments.values()].filter((a) => wanted.has(k15(a.ParentId)));
    },
    async attachmentBody(a) {
      const run = (a as AttachmentRow & { run?: string }).run;
      return a.file && run ? sink.readBytes(`${root}/${run}/${a.file}`) : undefined;
    },
  };
}

export type CopyFilesResult = {
  files: number;
  links: number;
  attachments: number;
  skipped: Skipped[];
  failures: Array<{ id: string; name: string; error: string }>;
  /** Old ContentDocument / Attachment Id -> new one (re-runs skip what is already there). */
  ids: Record<string, string>;
  /** For undo. */
  created: Array<{ object: string; ids: string[] }>;
};

type SaveResult = { id?: string; success?: boolean; errors?: Array<{ message: string }> };
const errorOf = (e: unknown): string => (e as Error).message ?? String(e);

/**
 * Uploads the files and attachments of the copied records into the target and links them to
 * the new records. `recordIds` maps old record Ids to new ones; `known` holds what earlier runs
 * already uploaded (only missing links are added then).
 */
export async function copyFiles(
  source: FileSource,
  target: SalesforceClient,
  recordIds: Record<string, string>,
  options: { choice: FilesChoice; known?: Record<string, string>; onProgress?: (text: string) => void }
): Promise<CopyFilesResult> {
  const { choice } = options;
  const known = options.known ?? {};
  const result: CopyFilesResult = {
    files: 0,
    links: 0,
    attachments: 0,
    skipped: [],
    failures: [],
    ids: {},
    created: [],
  };
  const limit = Math.min(choice.maxMB, MAX_UPLOAD_MB) * MB;
  const newRecord = (old: string): string | undefined =>
    recordIds[old] ?? Object.entries(recordIds).find(([k]) => k.slice(0, 15) === old.slice(0, 15))?.[1];
  const olds = Object.keys(recordIds);
  const createdDocs: string[] = [];
  const createdAttachments: string[] = [];

  if (choice.files && olds.length) {
    options.onProgress?.('Finding the files of the copied records…');
    const links = (await source.links(olds)).filter((l) => newRecord(l.LinkedEntityId));
    const docs = [...new Set(links.map((l) => l.ContentDocumentId))];
    const versions = new Map((await source.versions(docs)).map((v) => [v.ContentDocumentId, v]));
    for (const [i, doc] of docs.entries()) {
      const docLinks = links.filter((l) => l.ContentDocumentId === doc);
      let newDoc = known[doc];
      const linkedNow = new Set<string>();
      /* eslint-disable no-await-in-loop */
      if (!newDoc) {
        const v = versions.get(doc);
        if (!v) {
          result.skipped.push({ id: doc, name: doc, reason: 'not in the source' });
          continue;
        }
        if (v.file === '') {
          result.skipped.push({
            id: doc,
            name: v.Title,
            reason: 'not in the backup (too large when it was backed up)',
          });
          continue;
        }
        if (Number(v.ContentSize) > limit) {
          result.skipped.push({
            id: doc,
            name: v.Title,
            reason: `larger than ${Math.min(choice.maxMB, MAX_UPLOAD_MB)} MB`,
          });
          continue;
        }
        options.onProgress?.(`Uploading file ${i + 1}/${docs.length}: ${v.Title}`);
        try {
          const data = await source.data(v);
          if (!data) throw new Error('The file is not in the backup.');
          const first = newRecord(docLinks[0].LinkedEntityId)!;
          const saved = await target.rest<SaveResult>('POST', '/sobjects/ContentVersion', {
            Title: v.Title,
            PathOnClient: v.PathOnClient || `${v.Title}${v.FileExtension ? `.${v.FileExtension}` : ''}`,
            Description: v.Description || undefined,
            VersionData: toBase64(data),
            FirstPublishLocationId: first,
          });
          const created = await query(target, `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${saved.id}'`);
          newDoc = text(created.rows[0]?.ContentDocumentId);
          result.ids[doc] = newDoc;
          createdDocs.push(newDoc);
          result.files++;
          linkedNow.add(first.slice(0, 15));
        } catch (e) {
          result.failures.push({ id: doc, name: v.Title, error: errorOf(e) });
          continue;
        }
      }
      // The other records the file was shared with
      for (const l of docLinks) {
        const entity = newRecord(l.LinkedEntityId)!;
        if (linkedNow.has(entity.slice(0, 15))) continue;
        try {
          await target.rest('POST', '/sobjects/ContentDocumentLink', {
            ContentDocumentId: newDoc,
            LinkedEntityId: entity,
            ShareType: l.ShareType || 'V',
            Visibility: l.Visibility || 'AllUsers',
          });
          result.links++;
        } catch (e) {
          // Already linked (a re-run) is fine
          if (!/DUPLICATE|already linked/i.test(errorOf(e)))
            result.failures.push({ id: doc, name: `link to ${entity}`, error: errorOf(e) });
        }
      }
      /* eslint-enable no-await-in-loop */
    }
  }

  if (choice.attachments && olds.length) {
    options.onProgress?.('Finding the attachments of the copied records…');
    const list = (await source.attachments(olds)).filter((a) => newRecord(a.ParentId) && !known[a.Id]);
    for (const [i, a] of list.entries()) {
      if (Number(a.BodyLength) > limit) {
        result.skipped.push({
          id: a.Id,
          name: a.Name,
          reason: `larger than ${Math.min(choice.maxMB, MAX_UPLOAD_MB)} MB`,
        });
        continue;
      }
      options.onProgress?.(`Uploading attachment ${i + 1}/${list.length}: ${a.Name}`);
      try {
        /* eslint-disable no-await-in-loop */
        const body = await source.attachmentBody(a);
        if (!body) throw new Error('The attachment is not in the backup.');
        const saved = await target.rest<SaveResult>('POST', '/sobjects/Attachment', {
          ParentId: newRecord(a.ParentId),
          Name: a.Name,
          ContentType: a.ContentType || undefined,
          Description: a.Description || undefined,
          IsPrivate: a.IsPrivate === 'true',
          Body: toBase64(body),
        });
        /* eslint-enable no-await-in-loop */
        if (saved.id) {
          result.ids[a.Id] = saved.id;
          createdAttachments.push(saved.id);
          result.attachments++;
        }
      } catch (e) {
        result.failures.push({ id: a.Id, name: a.Name, error: errorOf(e) });
      }
    }
  }
  // Undo deletes these first (before the records they hang on)
  if (createdAttachments.length) result.created.push({ object: 'Attachment', ids: createdAttachments });
  if (createdDocs.length) result.created.push({ object: 'ContentDocument', ids: createdDocs });
  return result;
}

/** How many files and attachments the records have, and their size, before copying. */
export async function countFiles(
  source: FileSource,
  recordIds: string[],
  choice: FilesChoice
): Promise<{ files: number; attachments: number; bytes: number; tooLarge: number }> {
  const limit = Math.min(choice.maxMB, MAX_UPLOAD_MB) * MB;
  let bytes = 0;
  let tooLarge = 0;
  let files = 0;
  let attachments = 0;
  if (choice.files) {
    const links = await source.links(recordIds);
    const versions = await source.versions([...new Set(links.map((l) => l.ContentDocumentId))]);
    for (const v of versions) {
      if (Number(v.ContentSize) > limit) tooLarge++;
      else {
        files++;
        bytes += Number(v.ContentSize) || 0;
      }
    }
  }
  if (choice.attachments) {
    for (const a of await source.attachments(recordIds)) {
      if (Number(a.BodyLength) > limit) tooLarge++;
      else {
        attachments++;
        bytes += Number(a.BodyLength) || 0;
      }
    }
  }
  return { files, attachments, bytes, tooLarge };
}
