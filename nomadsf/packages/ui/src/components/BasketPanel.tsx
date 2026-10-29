import { useContext, useState } from 'react';
import {
  accessFiles,
  accessNames,
  basketObjects,
  basketRecords,
  basketSheets,
  basketUsers,
  writeWorkbook,
} from '@nomadsf/core';
import { basket, useBasket } from '../basket';
import { GoContext, handoff, useStudio } from '../context';
import { usePair } from '../pair';
import { download } from './DataTable';

/**
 * The records picked on Record › Related: copy exactly them to another org (Migrate), save them as
 * a workbook, or open a saved one to copy it. A user goes with only the access picked under them.
 */
export function BasketPanel() {
  const { client, org } = useStudio();
  const go = useContext(GoContext);
  const [pair, setPair] = usePair();
  const items = useBasket(org.id);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const counts = Object.entries(
    items.reduce<Record<string, number>>((n, i) => ({ ...n, [i.object]: (n[i.object] ?? 0) + 1 }), {})
  )
    .map(([object, n]) => `${n} ${object}`)
    .join(' · ');

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(what);
    try {
      await fn();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = () =>
    run('Reading the users and their access…', async () => {
      const users = await basketUsers(client, items, org.label);
      handoff.migrate(org.id, basketObjects(items), users);
      setPair({ a: org.id, b: pair.b === org.id ? '' : pair.b });
      setStatus('');
      go?.('migrate');
    });

  const save = () =>
    run('Reading the records…', async () => {
      const records = await basketRecords(client, items);
      const users = await basketUsers(client, items, org.label);
      setStatus('Reading the permission sets and groups (to make them where they are missing)…');
      const metadata = await accessFiles(client, accessNames(users));
      download(
        `basket-${org.label}-${new Date().toLocaleDateString('en-CA')}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        writeWorkbook(basketSheets({ records, users, metadata })),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      setStatus('✓ Saved. Open it here later (or in Migrate › From files) to copy it into any org.');
    });

  return (
    <div className="basket">
      <div className="form">
        <b>Basket</b>
        {items.length ? (
          <button className="link" onClick={() => setOpen(!open)} title="What is in the basket">
            {counts} {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="muted">empty: tick records below and add them</span>
        )}
        <span className="grow" />
        <button className="primary" disabled={!items.length || busy} onClick={() => void copy()}>
          Copy to another org…
        </button>
        <button disabled={!items.length || busy} onClick={() => void save()}>
          Save as Excel
        </button>
        <label className="file-button" title="A basket saved as Excel: copy it into any org">
          Open a saved Excel…
          <input
            type="file"
            accept=".xlsx"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              handoff.migrateFile(f);
              go?.('migrate');
            }}
          />
        </label>
      </div>
      {status && <p className="muted">{status}</p>}
      {open && items.length > 0 && (
        <div className="basket-items">
          {items.map((i) => (
            <div key={i.id} className="relation-record">
              <span className="muted">{i.object}</span> {i.name}
              <button className="link danger" title="Take it out" onClick={() => basket.remove(org.id, [i.id])}>
                ×
              </button>
            </div>
          ))}
          <button className="link danger" onClick={() => basket.clear(org.id)}>
            Empty the basket
          </button>
        </div>
      )}
    </div>
  );
}
