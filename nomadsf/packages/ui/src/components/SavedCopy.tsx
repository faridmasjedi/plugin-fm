import { useEffect, useMemo, useState } from 'react';
import {
  ACCESS_SECTIONS,
  fromCopySheets,
  readTableFile,
  type AccessFile,
  type FileTable,
  type UserCopy,
} from '@nomadsf/core';
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
  const [olderReport, setOlderReport] = useState(false);
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
        setOlderReport(Boolean(saved.olderReport));
      })
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [file]);

  // Rows are ticked unless taken out; a sheet's key is its name, a row's is sheet:Id (or sheet:#n)
  const accessKey = (user: string, section: string, name: string) => `access:${user}:${section}:${name}`;
  const rowKey = (t: FileTable, r: Record<string, string>, i: number) => `${t.name}:${r.Id || `#${i}`}`;
  const what = useMemo(
    () => ({
      records: {
        kind: 'file' as const,
        tables: (tables ?? [])
          .filter((t) => !off.has(t.name))
          .map((t) => ({ ...t, rows: t.rows.filter((r, i) => !off.has(rowKey(t, r, i))) })),
      },
      // Only the access still ticked goes with the user
      user:
        users[0] && !off.has(`user:${users[0].username}`)
          ? {
              ...users[0],
              lines: users[0].lines.filter((l) => !off.has(accessKey(users[0].username, l.Section, l.Name))),
            }
          : undefined,
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
            {users.length && !tables.length
              ? 'Everything is copied; untick what the user should not get. A user already there is completed, a missing one is created.'
              : "Each sheet is an object; untick what not to copy. Lookups between the sheets (an Account's Contacts…) point to the new records."}
          </p>
          {olderReport && (
            <p className="warn-text small">
              ⚠ This workbook was saved before it carried the user's profile, role and manager by name: the access below
              is copied, but to create the user, save the workbook again (Access › Users › Everything) or use the
              Snapshot (CSV).
            </p>
          )}
          <ul className="relation-tree root">
            {users.map((u) => (
              <li key={u.username}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!off.has(`user:${u.username}`)}
                    onChange={(e) => toggle(`user:${u.username}`, e.target.checked)}
                  />{' '}
                  <b>User {u.username}</b>
                </label>
                {/* Their access by kind, each kind a line that wraps (a user can have dozens) */}
                <ul className="relation-tree saved-user-access">
                  {(() => {
                    const of = (section: string, name: string) =>
                      u.lines.find((l) => l.Section === section && l.Name === name)?.Value ?? '';
                    const details = [
                      [of('field', 'FirstName'), of('field', 'LastName')].filter(Boolean).join(' '),
                      of('field', 'Email'),
                      of('field', 'Title'),
                      of('lookup', 'ProfileId') && `profile ${of('lookup', 'ProfileId')}`,
                      of('lookup', 'UserRoleId') && `role ${of('lookup', 'UserRoleId')}`,
                      of('lookup', 'ManagerId') && `manager ${of('lookup', 'ManagerId')}`,
                    ].filter(Boolean);
                    const fields = u.lines.filter((l) => l.Section === 'field' && l.Value !== '').length;
                    return (
                      <li>
                        <span className="muted">Details ({fields} fields):</span> {details.join(' · ') || '—'}
                      </li>
                    );
                  })()}
                  {ACCESS_SECTIONS.map(({ section, label }) => {
                    const names = u.lines.filter((l) => l.Section === section).map((l) => l.Name);
                    if (!names.length) return null;
                    const userOff = off.has(`user:${u.username}`);
                    const keys = names.map((n) => accessKey(u.username, section, n));
                    const on = keys.filter((k) => !off.has(k)).length;
                    return (
                      <li key={section}>
                        {/* All of a kind at once, or one by one: everything is ticked until taken out */}
                        <label className="check">
                          <input
                            type="checkbox"
                            disabled={userOff}
                            checked={on === keys.length}
                            ref={(el) => {
                              if (el) el.indeterminate = on > 0 && on < keys.length;
                            }}
                            onChange={(e) => {
                              const next = new Set(off);
                              for (const k of keys) {
                                if (e.target.checked) next.delete(k);
                                else next.add(k);
                              }
                              setOff(next);
                            }}
                          />{' '}
                          <span className="muted">
                            {label} ({on === keys.length ? names.length : `${on} of ${names.length}`}):
                          </span>
                        </label>{' '}
                        <span className="saved-access-items">
                          {names.map((n) => {
                            const k = accessKey(u.username, section, n);
                            return (
                              <label key={k} className="check">
                                <input
                                  type="checkbox"
                                  disabled={userOff}
                                  checked={!off.has(k)}
                                  onChange={(e) => toggle(k, e.target.checked)}
                                />
                                {n}
                              </label>
                            );
                          })}
                        </span>
                      </li>
                    );
                  })}
                  {!u.lines.some((l) => ACCESS_SECTIONS.some((a) => a.section === l.Section)) && (
                    <li className="muted">no access</li>
                  )}
                </ul>
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
