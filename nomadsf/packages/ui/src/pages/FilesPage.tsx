import { useContext, useState } from 'react';
import { fromCopySheets, isSandboxWorkbook, readTableFile, type AccessFile, type UserCopy } from '@nomadsf/core';
import { GoContext, useStudio } from '../context';
import { SavedCopy } from '../components/SavedCopy';
import { UserSnapshot } from '../components/UserSnapshot';
import { UsersFromWorkbook } from '../components/UsersFromWorkbook';
import { CsvComparePage } from './CsvComparePage';
import { Status } from '../statusLog';

/** What a file is, as far as NomadSF can tell from its name and first lines or sheets. */
type Kind =
  | { kind: 'snapshot' }
  | { kind: 'user-workbook' }
  | { kind: 'users'; users: UserCopy[]; metadata: AccessFile[] }
  | { kind: 'sandbox' }
  | { kind: 'records-workbook'; sheets: string[] }
  | { kind: 'table' }
  | { kind: 'manifest' }
  | { kind: 'unknown'; why: string };

async function kindOf(file: File): Promise<Kind> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xml')) {
    const text = await file.text();
    return /<Package[\s>]/.test(text)
      ? { kind: 'manifest' }
      : { kind: 'unknown', why: 'an XML file that is not a package.xml' };
  }
  if (name.endsWith('.csv')) {
    const first = (await file.slice(0, 2000).text()).replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
    const columns = first.split(',').map((c) => c.replace(/"/g, '').trim());
    if (['Section', 'Name', 'Value'].every((c) => columns.includes(c))) return { kind: 'snapshot' };
    return { kind: 'table' };
  }
  if (name.endsWith('.xlsx') || name.endsWith('.zip')) {
    const tables = (await readTableFile(file.name, new Uint8Array(await file.arrayBuffer()))).filter(
      (t) => t.columns.length
    );
    const sheets = tables.map((t) => t.name);
    if (isSandboxWorkbook(tables)) return { kind: 'sandbox' };
    // Several users (a users workbook): all in one go
    const copy = fromCopySheets(tables);
    if (copy.users.length > 1) return { kind: 'users', users: copy.users, metadata: copy.metadata };
    if (sheets.includes('NomadSF users') || (sheets.includes('Details') && sheets.includes('Permission sets')))
      return { kind: 'user-workbook' };
    if (sheets.length > 1 && tables.every((t) => t.columns.includes('Id'))) return { kind: 'records-workbook', sheets };
    if (tables.length) return { kind: 'table' };
    return { kind: 'unknown', why: 'no table in it' };
  }
  return { kind: 'unknown', why: 'not a CSV, Excel workbook, zip or package.xml' };
}

const ABOUT: Record<Kind['kind'], string> = {
  snapshot: 'A user snapshot (Access › Users › Snapshot): the same user is found here and compared.',
  'user-workbook': 'A user’s Everything workbook: tick what the user should get, then copy them into this org.',
  users: 'Several users: tick the ones to create or complete in this org, all in one go.',
  sandbox: 'A workbook saved before a sandbox refresh: open it in Sandbox refresh › After the refresh.',
  'records-workbook': 'Records saved from Data › Record (a sheet per object): tick what to copy into this org.',
  table: 'A table of records: compare it with the org, or open it in Import / Update / Delete.',
  manifest: 'A package.xml: Check a manifest compares its components with an org and deploys them.',
  unknown: '',
};

/**
 * Compare & Deploy › Open a file: a snapshot, a workbook, a CSV or a package.xml next to the org on screen. NomadSF
 * says what the file is and opens it in the tool that uses it — nothing is changed until that tool asks.
 */
export function FilesPage() {
  const { org } = useStudio();
  const go = useContext(GoContext);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [tableAs, setTableAs] = useState<'compare' | 'copy'>('compare');
  const [status, setStatus] = useState('');

  const open = async (f: File) => {
    setFile(null);
    setKind(null);
    setStatus(`Reading ${f.name}…`);
    try {
      const k = await kindOf(f);
      setFile(f);
      setKind(k);
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Open a file</h2>
        <span className="muted">A snapshot, workbook, CSV or package.xml next to {org.label}</span>
      </div>
      <div className="card section">
        <div className="form">
          <label className="file-button primary-file">
            {file ? 'Open another file…' : 'Open a file…'}
            <input
              type="file"
              accept=".csv,.xlsx,.zip,.xml,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void open(f);
              }}
            />
          </label>
          {file && <b>{file.name}</b>}
          <Status text={status} />
        </div>
        {!file && (
          <ul className="muted file-kinds">
            <li>
              <b>User snapshot</b> (.csv from Access › Users): find the same user here, see what differs, make them
              match or create them.
            </li>
            <li>
              <b>Everything workbook</b> of a user, or <b>records saved</b> from Data › Record (.xlsx): tick what to
              copy, copy it into this org.
            </li>
            <li>
              <b>A CSV or Excel table</b> of records: compare it with the org field by field, then make the org match.
            </li>
            <li>
              <b>package.xml</b>: check it against an org (Check a manifest).
            </li>
          </ul>
        )}
        {kind && kind.kind !== 'unknown' && <p className="note">{ABOUT[kind.kind]}</p>}
        {kind?.kind === 'unknown' && <p className="bad">❌ NomadSF does not know this file: {kind.why}.</p>}
      </div>

      {file && kind?.kind === 'snapshot' && <UserSnapshot key={file.name + file.size} initialFile={file} />}
      {file && (kind?.kind === 'user-workbook' || kind?.kind === 'records-workbook') && (
        <SavedCopy key={file.name + file.size} file={file} onClose={() => setFile(null)} />
      )}
      {file && kind?.kind === 'table' && (
        <>
          <div className="segmented" role="group" aria-label="Use the table to">
            <button className={tableAs === 'compare' ? 'active' : ''} onClick={() => setTableAs('compare')}>
              Compare with the org
            </button>
            <button className={tableAs === 'copy' ? 'active' : ''} onClick={() => setTableAs('copy')}>
              Copy as new records
            </button>
          </div>
          {tableAs === 'compare' ? (
            <CsvComparePage key={file.name + file.size} initialFile={file} />
          ) : (
            <SavedCopy key={`copy-${file.name}${file.size}`} file={file} onClose={() => setFile(null)} />
          )}
        </>
      )}
      {file && kind?.kind === 'users' && (
        <UsersFromWorkbook key={file.name + file.size} users={kind.users} metadata={kind.metadata} source={file.name} />
      )}
      {file && kind?.kind === 'sandbox' && (
        <div className="form">
          <button className="primary" onClick={() => go?.('sandbox')}>
            Open Sandbox refresh
          </button>
          <span className="muted">then After the refresh, and choose this workbook there</span>
        </div>
      )}
      {file && kind?.kind === 'manifest' && (
        <div className="form">
          <button className="primary" onClick={() => go?.('manifest')}>
            Open Check a manifest
          </button>
          <span className="muted">and choose this file there</span>
        </div>
      )}
    </div>
  );
}
