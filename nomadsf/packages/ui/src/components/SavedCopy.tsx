import { useEffect, useMemo, useState } from 'react';
import { fromCopySheets, readTableFile, type AccessFile, type FileTable, type UserCopy } from '@nomadsf/core';
import { CopyBar } from './CopyBar';

const nameOf = (row: Record<string, string>): string =>
  row.Name || row.CaseNumber || row.Subject || row.Title || row.Username || row.Id || '';

/**
 * Record › Open a saved copy: a workbook saved from Record › Related (or any workbook with a sheet
 * per object), as a tree to tick, then Copy into any org — the links between its records kept.
 */
export function SavedCopy({ file, onClose }: { file: File; onClose: () => void }) {
  const [tables, setTables] = useState<FileTable[] | null>(null);
  const [users, setUsers] = useState<UserCopy[]>([]);
  const [metadata, setMetadata] = useState<AccessFile[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    void file
      .arrayBuffer()
      .then((b) => readTableFile(file.name, new Uint8Array(b)))
      .then((read) => {
        if (canceled) return;
        const saved = fromCopySheets(read.filter((t) => t.columns.length));
        setTables(saved.tables);
        setUsers(saved.users);
        setMetadata(saved.metadata);
      })
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [file]);

  // Rows are ticked unless taken out; a sheet's key is its name, a row's is sheet:Id (or sheet:#n)
  const rowKey = (t: FileTable, r: Record<string, string>, i: number) => `${t.name}:${r.Id || `#${i}`}`;
  const what = useMemo(
    () => ({
      records: {
        kind: 'file' as const,
        tables: (tables ?? [])
          .filter((t) => !off.has(t.name))
          .map((t) => ({ ...t, rows: t.rows.filter((r, i) => !off.has(rowKey(t, r, i))) })),
      },
      user: users[0] && !off.has(`user:${users[0].username}`) ? users[0] : undefined,
      metadata,
    }),
    [tables, users, metadata, off]
  );
  const toggle = (key: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(key);
    else next.add(key);
    setOff(next);
  };

  return (
    <div className="card section record-tree">
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>{file.name}</h3>
        <span className="grow" />
        <button onClick={onClose}>Close</button>
      </div>
      {error && <p className="bad">❌ {error}</p>}
      {!tables ? (
        <p className="muted">Reading…</p>
      ) : (
        <>
          <p className="muted help">
            Each sheet is an object; untick what not to copy. Lookups between the sheets (an Account's Contacts…) point
            to the new records.
          </p>
          <ul className="relation-tree root">
            {users.map((u) => (
              <li key={u.username}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!off.has(`user:${u.username}`)}
                    onChange={(e) => toggle(`user:${u.username}`, e.target.checked)}
                  />{' '}
                  <b>User {u.username}</b> with{' '}
                  {u.lines
                    .filter((l) => !['info', 'field', 'lookup'].includes(l.Section))
                    .map((l) => l.Name)
                    .join(', ') || 'no access'}
                </label>
              </li>
            ))}
            {tables.map((t) => (
              <li key={t.name}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!off.has(t.name)}
                    onChange={(e) => toggle(t.name, e.target.checked)}
                  />{' '}
                  <b>{t.name}</b> ({t.rows.length})
                </label>{' '}
                <button
                  className="link"
                  onClick={() => {
                    const next = new Set(open);
                    if (next.has(t.name)) next.delete(t.name);
                    else next.add(t.name);
                    setOpen(next);
                  }}
                >
                  {open.has(t.name) ? '▾' : '▸'}
                </button>
                {open.has(t.name) && (
                  <ul className="relation-tree">
                    {t.rows.map((r, i) => (
                      <li key={rowKey(t, r, i)}>
                        <label className="check">
                          <input
                            type="checkbox"
                            disabled={off.has(t.name)}
                            checked={!off.has(t.name) && !off.has(rowKey(t, r, i))}
                            onChange={(e) => toggle(rowKey(t, r, i), e.target.checked)}
                          />{' '}
                          {nameOf(r)} <span className="muted mono">{r.Id}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <CopyBar what={what} />
        </>
      )}
    </div>
  );
}
