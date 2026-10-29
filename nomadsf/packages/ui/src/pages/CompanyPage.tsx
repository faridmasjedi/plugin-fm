import { useEffect, useState } from 'react';
import { companyInformation, type InfoField } from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable } from '../components/DataTable';

/** Org › Company information: every field of the Organization record, grouped. */
export function CompanyPage() {
  const { client, org } = useStudio();
  const [fields, setFields] = useState<InfoField[] | null>(null);
  const [onlyFilled, setOnlyFilled] = useState(true);
  const [status, setStatus] = useState('');
  useEffect(() => {
    setFields(null);
    companyInformation(client)
      .then(setFields)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client]);
  const shown = (fields ?? []).filter((f) => !onlyFilled || f.value !== '');
  const groups = [...new Set(shown.map((f) => f.group))];
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Company information</h2>
        <span className="muted">Company and org information of {org.label}</span>
        <span className="grow" />
        <label className="check">
          <input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} /> Only fields
          with a value
        </label>
      </div>
      {status && <p className="muted">{status}</p>}
      {!fields && !status && <p className="muted">Reading…</p>}
      {groups.map((g) => (
        <div key={g} className="card section">
          <h3>{g}</h3>
          <DataTable
            columns={['label', 'value', 'name']}
            rows={shown.filter((f) => f.group === g).map((f) => ({ ...f }))}
            rowKey="name"
            name={`${org.label}-company-${g}`}
          />
        </div>
      ))}
    </div>
  );
}
