import { useEffect, useState, type ReactNode } from 'react';
import {
  applyAccessChanges,
  describeChange,
  type AccessChange,
  type Difference,
  type SalesforceClient,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { orgFacts } from '../host';
import { DataTable } from './DataTable';
import { askTyped } from './Dialogs';
import { cannotChangePermissions, useAccessOf } from '../access';

/**
 * The differences; comparing permission sets or profiles of two orgs, tick some and copy A's access into B
 * (system permissions, object and field access — B's name is asked first).
 */
export function DiffTable({
  diff,
  name,
  note,
  copy,
}: {
  diff: Difference[];
  name: string;
  note: ReactNode;
  copy?: { clientB: SalesforceClient; idB: string; what: string; labelB: string; onCopied: () => void };
}) {
  const { logActivity } = useStudio();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  // B's user must be able to change permissions (checked once per org)
  const blocked = cannotChangePermissions(useAccessOf(copy?.clientB), copy?.labelB ?? 'B');
  useEffect(() => setPicked(new Set()), [diff]);
  const canCopy = Boolean(copy && diff.some((d) => d.change));
  const run = async () => {
    if (!copy) return;
    const changes = [...picked].map((k) => diff[Number(k)]?.change).filter((c): c is AccessChange => Boolean(c));
    if (!changes.length) return;
    const production = await orgFacts(copy.clientB)
      .then((f) => !f.isSandbox)
      .catch(() => false);
    const shown = changes.slice(0, 12).map((c) => `• ${describeChange(c)}`);
    const ok = await askTyped(
      `Copy ${changes.length} permission(s) of ${copy.what}:\n${shown.join('\n')}${
        changes.length > shown.length ? `\n… and ${changes.length - shown.length} more` : ''
      }${production ? `\n\n⚠ ${copy.labelB} is a PRODUCTION org.` : ''}`,
      copy.labelB,
      { ok: 'Copy', danger: production }
    );
    if (!ok) return;
    setStatus('Copying…');
    try {
      const result = await applyAccessChanges(copy.clientB, copy.idB, changes);
      logActivity('copy permissions', { into: copy.labelB, applied: result.applied, failed: result.failures.length });
      setStatus(
        result.failures.length
          ? `✓ ${result.applied} copied. ❌ ${result.failures.length} failed: ${result.failures
              .map((f) => `${f.change} (${f.error})`)
              .join('; ')}`
          : `✓ ${result.applied} copied into ${copy.labelB}.`
      );
      copy.onCopied();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  return (
    <>
      <DataTable
        columns={['area', 'item', 'a', 'b']}
        rows={diff.map((d, i) => ({ area: d.area, item: d.item, a: d.a, b: d.b, key: i }))}
        rowKey="key"
        name={name}
        note={note}
        selected={canCopy ? picked : undefined}
        onSelectedChange={canCopy ? setPicked : undefined}
      />
      {canCopy && (
        <div className="form">
          <button
            className="primary"
            disabled={picked.size === 0 || Boolean(blocked)}
            title={blocked}
            onClick={() => void run()}
          >
            Copy A&apos;s access into B ({picked.size})…
          </button>
          <span className={blocked && !status ? 'bad-text' : 'muted'}>
            {status || blocked || 'tick the differences to make B like A'}
          </span>
        </div>
      )}
    </>
  );
}
