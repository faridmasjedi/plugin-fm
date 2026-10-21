import { useEffect, useMemo, useState } from 'react';
import {
  describeGlobal,
  distinctValues,
  estimateQueries,
  idObjects,
  joinBack,
  matchKey,
  lookupFields,
  lookupValues,
  parseCsv,
  type CsvTable,
  type LookupField,
  type Row,
  type SObjectSummary,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { useStudio } from '../context';
import { askConfirm } from '../components/Dialogs';

/** Field types a file value can be matched on (text-like, Ids and numbers). */
const MATCHABLE = new Set(['string', 'email', 'id', 'reference', 'phone', 'url', 'picklist', 'int', 'double']);
/** Above this many queries, ask before running. */
const CONFIRM_QUERIES = 50;

type Result = {
  columns: string[];
  rows: Row[];
  records: Row[];
  notFound: number;
  queries: number;
  fields: string[];
  /** Different file values that matched a record. */
  foundValues: number;
};

/** "VLOOKUP against Salesforce": a column of a CSV file looked up in any object, joined back onto the file. */
export function LookupPage() {
  const { client } = useStudio();
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<CsvTable | null>(null);
  const [column, setColumn] = useState('');
  const [objects, setObjects] = useState<SObjectSummary[]>([]);
  const [idOf, setIdOf] = useState<string[] | undefined | null>(null);
  const [sobject, setSobject] = useState('');
  const [matchField, setMatchField] = useState('');
  const [fields, setFields] = useState<LookupField[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [related, setRelated] = useState('');
  const [fieldFilter, setFieldFilter] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [view, setView] = useState<'file' | 'records'>('file');
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    describeGlobal(client)
      .then(setObjects)
      .catch(() => undefined);
  }, [client]);

  const values = useMemo(() => (table && column ? distinctValues(table.rows, column) : []), [table, column]);

  // Are the values Ids? Then the object comes from their prefix
  useEffect(() => {
    setIdOf(null);
    setResult(null);
    if (!values.length) return;
    idObjects(client, values)
      .then((found) => {
        setIdOf(found);
        if (found) {
          setSobject(found[0]);
          setMatchField('Id');
        } else {
          setMatchField('');
        }
      })
      .catch(() => setIdOf(undefined));
  }, [client, values]);

  // Fields of the chosen object; the name field is chosen to start with (related fields belong to one object)
  useEffect(() => {
    setFields([]);
    setRelated('');
    if (!/^\w+$/.test(sobject)) return;
    lookupFields(client, sobject)
      .then((list) => {
        setFields(list);
        setChosen(new Set(list.filter((f) => f.nameField).map((f) => f.name)));
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, sobject]);

  const open = async (file: File) => {
    setStatus('');
    setResult(null);
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.columns.length) throw new Error('The file has no header row.');
      setTable(parsed);
      setFileName(file.name.replace(/\.csv$/i, ''));
      // Start with the first column that looks like an Id
      setColumn(parsed.columns.find((c) => /id$/i.test(c)) ?? parsed.columns[0]);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const bringBack = [
    ...fields.filter((f) => chosen.has(f.name)).map((f) => f.name),
    ...related
      .split(',')
      .map((f) => f.trim())
      .filter((f) => /^\w+(\.\w+)+$/.test(f)),
  ];
  const queries = estimateQueries(values.length);
  const ready = Boolean(table && column && sobject && matchField && bringBack.length && values.length);

  const run = async () => {
    if (!table || !ready) return;
    if (
      queries > CONFIRM_QUERIES &&
      !(await askConfirm(
        `This looks up ${values.length.toLocaleString()} values with about ${queries} API calls. Continue?`
      ))
    ) {
      return;
    }
    setRunning(true);
    setStatus('Looking up…');
    try {
      const found = await lookupValues(client, { sobject, matchField, values, fields: bringBack }, (done, total) =>
        setStatus(`Looking up… ${done.toLocaleString()} of ${total.toLocaleString()} values`)
      );
      const joined = joinBack(table.rows, table.columns, column, matchField === 'Id', bringBack, found.found);
      const byId = matchField === 'Id';
      const foundValues = values.filter((v) => found.found.has(matchKey(v, byId))).length;
      setResult({ ...joined, records: found.records, queries: found.queries, fields: bringBack, foundValues });
      setView('file');
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const matchable = fields.filter((f) => f.filterable && MATCHABLE.has(f.type));
  const shownFields = fields.filter((f) => `${f.name} ${f.label}`.toLowerCase().includes(fieldFilter.toLowerCase()));

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Lookup</h2>
        <span className="muted">
          Look up a column of a CSV file in Salesforce and get the file back with the fields you choose
        </span>
      </div>

      <div className="card section lookup-steps">
        <div className="form">
          <label>
            1. CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void open(file);
              }}
            />
          </label>
          {table && (
            <span className="muted">
              {fileName}.csv · {table.rows.length.toLocaleString()} rows · {table.columns.length} columns
            </span>
          )}
        </div>

        {table && (
          <div className="form">
            <label>
              2. Column to look up
              <select value={column} onChange={(e) => setColumn(e.target.value)}>
                {table.columns.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <span className="muted">
              {values.length.toLocaleString()} different value(s)
              {values.length ? `, e.g. ${values.slice(0, 3).join(', ')}` : ''}
            </span>
          </div>
        )}

        {table && values.length > 0 && idOf === null && <p className="muted">Checking the values…</p>}

        {table && values.length > 0 && idOf !== null && (
          <div className="form">
            {idOf ? (
              <label>
                3. Ids of
                <select value={sobject} onChange={(e) => setSobject(e.target.value)}>
                  {idOf.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  3. Object
                  <input
                    list="lookup-objects"
                    value={sobject}
                    placeholder="e.g. User"
                    onChange={(e) => {
                      setSobject(e.target.value);
                      setMatchField('');
                    }}
                  />
                </label>
                <datalist id="lookup-objects">
                  {objects.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.label}
                    </option>
                  ))}
                </datalist>
                <label>
                  matched on
                  <select
                    value={matchField}
                    onChange={(e) => setMatchField(e.target.value)}
                    disabled={!matchable.length}
                  >
                    <option value="">Field…</option>
                    {matchable.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label} ({f.name})
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {idOf && idOf.length > 1 && (
              <span className="muted">
                The column has Ids of {idOf.join(', ')}; values of the other objects show as not found.
              </span>
            )}
          </div>
        )}

        {fields.length > 0 && matchField && (
          <div className="lookup-fields">
            <div className="form">
              <b>4. Fields to bring back</b>
              <input placeholder="Filter fields" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} />
              <button onClick={() => setChosen(new Set(fields.filter((f) => f.type !== 'base64').map((f) => f.name)))}>
                All fields
              </button>
              <button onClick={() => setChosen(new Set())}>None</button>
              <span className="muted">{chosen.size} chosen</span>
            </div>
            <div className="field-checks">
              {shownFields.map((f) => (
                <label key={f.name} className="check" title={`${f.name} · ${f.type}`}>
                  <input
                    type="checkbox"
                    checked={chosen.has(f.name)}
                    disabled={f.type === 'base64'}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(f.name);
                      else next.delete(f.name);
                      setChosen(next);
                    }}
                  />{' '}
                  {f.label}
                </label>
              ))}
            </div>
            <div className="form">
              <input
                style={{ minWidth: 360 }}
                placeholder="Related fields too, e.g. UserLicense.Name, Owner.Email"
                value={related}
                onChange={(e) => setRelated(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="form">
          <button className="primary" disabled={!ready || running} onClick={() => void run()}>
            {running ? 'Looking up…' : `Look up ${values.length.toLocaleString()} value(s)`}
          </button>
          {ready && (
            <span className="muted">
              about {queries} API call{queries === 1 ? '' : 's'} · read-only
            </span>
          )}
          {status && <span className="muted">{status}</span>}
        </div>
      </div>

      {result && (
        <div className="card section">
          <div className="metrics">
            <div className="metric">
              <b>{result.foundValues.toLocaleString()}</b>
              values found
            </div>
            <div className={`metric ${result.notFound ? 'bad' : ''}`}>
              <b>{result.notFound.toLocaleString()}</b>rows not found
            </div>
            <div className="metric">
              <b>{result.queries}</b>API calls
            </div>
          </div>
          {result.notFound > 0 && (
            <p className="muted" style={{ margin: 0 }}>
              Not found means no record matched, or the record exists but your user cannot see it (sharing, or system
              records Salesforce hides from queries).
            </p>
          )}
          <div className="tabs">
            <button className={`tab ${view === 'file' ? 'active' : ''}`} onClick={() => setView('file')}>
              Your file + Salesforce
            </button>
            <button className={`tab ${view === 'records' ? 'active' : ''}`} onClick={() => setView('records')}>
              Records found ({result.records.length.toLocaleString()})
            </button>
          </div>
          {view === 'file' ? (
            <DataTable
              name={`${fileName}-with-salesforce`}
              columns={result.columns}
              rows={result.rows}
              rowKey="__none"
            />
          ) : (
            <DataTable
              name={`${fileName}-${sobject}`}
              columns={['Id', ...new Set([matchField, ...result.fields])].filter((c, i, all) => all.indexOf(c) === i)}
              rows={result.records}
            />
          )}
        </div>
      )}
    </div>
  );
}
