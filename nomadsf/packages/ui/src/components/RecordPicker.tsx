import { useEffect, useState } from 'react';
import { query, type SalesforceClient } from '@nomadsf/core';
import { Status } from '../statusLog';

const nameFields = new WeakMap<SalesforceClient, Map<string, Promise<string>>>();

/** The name field of an object (Name, CaseNumber, Subject…), once per org. */
function nameFieldOf(client: SalesforceClient, sobject: string): Promise<string> {
  let cache = nameFields.get(client);
  if (!cache) nameFields.set(client, (cache = new Map()));
  if (!cache.has(sobject))
    cache.set(
      sobject,
      client
        .rest<{ fields: Array<{ name: string; nameField: boolean }> }>('GET', `/sobjects/${sobject}/describe`)
        .then((d) => d.fields.find((f) => f.nameField)?.name ?? 'Name')
        .catch(() => 'Name')
    );
  return cache.get(sobject)!;
}

const soqlText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, '\\$&');

/**
 * Find a record by name for a lookup field (ProfileId, UserRoleId, ManagerId…): type part of the
 * name (or List them all, for a name you do not know), choose one, and its Id is filled in.
 * Polymorphic lookups choose the object first.
 */
export function RecordPicker({
  client,
  objects,
  onPick,
}: {
  client: SalesforceClient;
  objects: string[];
  onPick: (id: string) => void;
}) {
  const [sobject, setSobject] = useState(objects[0] ?? '');
  const [text, setText] = useState('');
  const [found, setFound] = useState<Array<{ id: string; name: string }>>([]);
  const [status, setStatus] = useState('');

  // Every record of the object, by name (BusinessHours, a queue…: when the name is not known)
  const listAll = async () => {
    setText('');
    setStatus('Reading…');
    try {
      const field = await nameFieldOf(client, sobject);
      const r = await query(client, `SELECT Id, ${field} FROM ${sobject} ORDER BY ${field} LIMIT 200`);
      setFound(r.rows.map((row) => ({ id: String(row.Id), name: String(row[field] ?? row.Id) })));
      setStatus(r.rows.length ? (r.rows.length === 200 ? 'the first 200: type to narrow' : '') : 'None');
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  useEffect(() => {
    const term = text.trim();
    if (term.length < 2) return;
    setFound([]);
    if (term.length < 2 || !/^\w+$/.test(sobject)) return;
    let canceled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const field = await nameFieldOf(client, sobject);
          const r = await query(
            client,
            `SELECT Id, ${field} FROM ${sobject} WHERE ${field} LIKE '%${soqlText(term)}%' ORDER BY ${field} LIMIT 20`
          );
          if (!canceled) {
            setFound(r.rows.map((row) => ({ id: String(row.Id), name: String(row[field] ?? row.Id) })));
            setStatus(r.rows.length ? '' : 'No match');
          }
        } catch (e) {
          if (!canceled) setStatus((e as Error).message);
        }
      })();
    }, 300);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [client, sobject, text]);

  return (
    <span className="record-picker">
      {objects.length > 1 && (
        <select value={sobject} onChange={(e) => setSobject(e.target.value)}>
          {objects.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
      <input
        placeholder={`Find ${sobject} by name`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        title={`Type part of a ${sobject} name and choose it: its Id goes in the field`}
      />
      <button type="button" className="link" title={`Every ${sobject}, to choose one`} onClick={() => void listAll()}>
        List
      </button>
      {found.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            onPick(e.target.value);
            setText('');
          }}
        >
          <option value="">Choose ({found.length})…</option>
          {found.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      {status && <Status text={status} />}
    </span>
  );
}
