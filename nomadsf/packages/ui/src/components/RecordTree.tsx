import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  ACCESS_SECTIONS,
  accessLabels,
  childRecords,
  childrenSoql,
  recordLookups,
  relationCounts,
  takeUserSnapshot,
  userCopy,
  type ChildRelation,
  type CopyPick,
  type RecordLookup,
  type SnapshotLine,
} from '@nomadsf/core';
import { GoContext, handoff, useStudio } from '../context';
import { CopyBar } from './CopyBar';

/** What is ticked in the tree: key → the records it stands for. */
type Ticks = {
  has: (key: string) => boolean;
  set: (key: string, pick: CopyPick | null) => void;
  onOpen: (id: string) => void;
};
const TicksContext = createContext<Ticks | null>(null);
const useTicks = (): Ticks => useContext(TicksContext)!;

const groupKey = (parentId: string, r: Pick<ChildRelation, 'object' | 'field'>) => `${parentId}:${r.object}.${r.field}`;

/** One relationship under a record: tick it for all its records, or open it and tick some. */
function Group({ parentId, relation }: { parentId: string; relation: ChildRelation & { count: number } }) {
  const { client } = useStudio();
  const go = useContext(GoContext);
  const ticks = useTicks();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Array<{ id: string; name: string }> | null>(null);
  const key = groupKey(parentId, relation);
  const whole = ticks.has(key);

  const toggleOpen = async () => {
    setOpen(!open);
    if (!list) setList(await childRecords(client, relation, parentId, 200).catch(() => []));
  };

  return (
    <li>
      <label className="check">
        <input
          type="checkbox"
          checked={whole}
          onChange={(e) => {
            ticks.set(
              key,
              e.target.checked ? { object: relation.object, where: `${relation.field} = '${parentId}'` } : null
            );
            // The whole relationship stands for its records
            for (const r of list ?? []) ticks.set(`rec:${r.id}`, null);
          }}
        />{' '}
        <b>{relation.objectLabel}</b> ({relation.count.toLocaleString()})
      </label>{' '}
      <button className="link" onClick={() => void toggleOpen()} title="Its records">
        {open ? '▾' : '▸'}
      </button>{' '}
      <span className="muted mono">via {relation.field}</span>{' '}
      <button
        className="link"
        title="Open these records in Query"
        onClick={() =>
          void childrenSoql(client, relation, parentId, 2000).then((soql) => {
            handoff.query(soql);
            go?.('query');
          })
        }
      >
        Query
      </button>
      {open && (
        <ul className="relation-tree">
          {!list ? (
            <li className="muted">Reading…</li>
          ) : (
            list.map((r) => <RecordNode key={r.id} object={relation.object} id={r.id} name={r.name} inWhole={whole} />)
          )}
          {list && list.length === 200 && relation.count > 200 && (
            <li className="muted">
              The newest 200 of {relation.count.toLocaleString()}: tick the relationship for all.
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** A record: tick it, and ▸ shows what points to it (counted when opened). */
function RecordNode({
  object,
  id,
  name,
  inWhole,
  root = false,
}: {
  object: string;
  id: string;
  name: string;
  inWhole?: boolean;
  root?: boolean;
}) {
  const { client } = useStudio();
  const ticks = useTicks();
  const [open, setOpen] = useState(root);
  const [groups, setGroups] = useState<Array<ChildRelation & { count: number }> | null>(null);
  const [progress, setProgress] = useState('');

  useEffect(() => {
    if (!open || groups) return;
    let canceled = false;
    relationCounts(client, object, id, (done, total) => !canceled && setProgress(`${done} of ${total}`))
      .then((g) => !canceled && setGroups(g))
      .catch(() => !canceled && setGroups([]));
    return () => {
      canceled = true;
    };
  }, [open, groups, client, object, id]);

  return (
    <li>
      <label className="check">
        <input
          type="checkbox"
          disabled={inWhole}
          checked={inWhole || ticks.has(`rec:${id}`)}
          onChange={(e) => ticks.set(`rec:${id}`, e.target.checked ? { object, where: `Id = '${id}'` } : null)}
        />{' '}
        {root ? <b>{name || id}</b> : name || id}
      </label>{' '}
      {!root && (
        <>
          <button className="link" onClick={() => setOpen(!open)} title="What points to this record">
            {open ? '▾' : '▸'}
          </button>{' '}
          <button className="link muted" onClick={() => ticks.onOpen(id)} title="Open this record">
            open
          </button>
        </>
      )}
      {open && (
        <ul className="relation-tree">
          {!groups ? (
            <li className="muted">Counting what points to it… {progress}</li>
          ) : groups.length === 0 ? (
            <li className="muted">Nothing points to it.</li>
          ) : (
            groups.map((g) => <Group key={groupKey(id, g)} parentId={id} relation={g} />)
          )}
        </ul>
      )}
    </li>
  );
}

/** A user's access, to tick what goes with them: permission sets, groups, licenses, public groups, queues. */
function AccessTree({
  snapshot,
  picked,
  setPicked,
}: {
  snapshot: SnapshotLine[];
  picked: SnapshotLine[];
  setPicked: (next: SnapshotLine[]) => void;
}) {
  const { client } = useStudio();
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let canceled = false;
    void accessLabels(client).then((l) => !canceled && setLabels(l));
    return () => {
      canceled = true;
    };
  }, [client]);
  const [open, setOpen] = useState<Set<string>>(new Set(['permissionSet', 'permissionSetGroup']));
  const has = (l: SnapshotLine) => picked.some((p) => p.Section === l.Section && p.Name === l.Name);
  return (
    <ul className="relation-tree">
      {ACCESS_SECTIONS.map(({ section, label }) => {
        const lines = snapshot.filter((l) => l.Section === section);
        if (!lines.length) return null;
        const all = lines.every(has);
        return (
          <li key={section}>
            <label className="check">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) =>
                  setPicked([...picked.filter((p) => p.Section !== section), ...(e.target.checked ? lines : [])])
                }
              />{' '}
              <b>{label}</b> ({lines.length})
            </label>{' '}
            <button
              className="link"
              onClick={() => {
                const next = new Set(open);
                if (next.has(section)) next.delete(section);
                else next.add(section);
                setOpen(next);
              }}
            >
              {open.has(section) ? '▾' : '▸'}
            </button>
            {open.has(section) && (
              <ul className="relation-tree">
                {lines.map((l) => (
                  <li key={l.Name}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={has(l)}
                        onChange={(e) =>
                          setPicked(
                            e.target.checked
                              ? [...picked, l]
                              : picked.filter((p) => !(p.Section === l.Section && p.Name === l.Name))
                          )
                        }
                      />{' '}
                      {labels[`${l.Section}:${l.Name}`] || l.Name} <span className="muted mono">{l.Name}</span>
                      {l.Value && <span className="muted"> ({l.Value})</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What the record belongs to (its lookups), one line of links. */
function BelongsTo({ object, id, onOpen }: { object: string; id: string; onOpen: (id: string) => void }) {
  const { client } = useStudio();
  const [list, setList] = useState<RecordLookup[] | null>(null);
  useEffect(() => {
    let canceled = false;
    recordLookups(client, object, id)
      .then((l) => !canceled && setList(l))
      .catch(() => !canceled && setList([]));
    return () => {
      canceled = true;
    };
  }, [client, object, id]);
  if (!list?.length) return null;
  return (
    <p className="muted belongs-to">
      Belongs to:{' '}
      {list.map((l, i) => (
        <span key={l.field}>
          {i > 0 && ' · '}
          {l.label}{' '}
          <button className="link" onClick={() => onOpen(l.id)} title={`Open this ${l.object}`}>
            {l.name || l.id}
          </button>
        </span>
      ))}
    </p>
  );
}

/**
 * Record › Related: the record and what points to it, as a tree to tick. Copy puts exactly the
 * ticked records into another org (links between them kept); Save as Excel keeps them for later.
 * A user's tree is their access: the ticked permission sets, groups and licenses go with them.
 */
export function RecordTree({
  sobject,
  id,
  name,
  onOpen,
}: {
  sobject: string;
  id: string;
  name: string;
  onOpen: (id: string) => void;
}) {
  const { client, org } = useStudio();
  const [picks, setPicks] = useState<Map<string, CopyPick>>(
    () => new Map([[`rec:${id}`, { object: sobject, where: `Id = '${id}'` }]])
  );
  const [snapshot, setSnapshot] = useState<SnapshotLine[] | null>(null);
  const [picked, setPicked] = useState<SnapshotLine[]>([]);
  const [error, setError] = useState('');
  const isUser = sobject === 'User';

  useEffect(() => {
    if (!isUser) return;
    let canceled = false;
    takeUserSnapshot(client, id, org.label)
      .then((s) => !canceled && setSnapshot(s))
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [isUser, client, id, org.label]);

  const ticks = useMemo<Ticks>(
    () => ({
      has: (key) => picks.has(key),
      set: (key, pick) =>
        setPicks((now) => {
          const next = new Map(now);
          if (pick) next.set(key, pick);
          else next.delete(key);
          return next;
        }),
      onOpen,
    }),
    [picks, onOpen]
  );

  const what = useMemo(
    () =>
      isUser
        ? {
            records: { kind: 'org' as const, picks: [] },
            user: snapshot && picks.has(`rec:${id}`) ? userCopy(snapshot, picked) : undefined,
            saveAs: `${name || id}-${new Date().toLocaleDateString('en-CA')}`,
          }
        : {
            records: { kind: 'org' as const, picks: [...picks.values()] },
            saveAs: `${sobject}-${name || id}-${new Date().toLocaleDateString('en-CA')}`,
          },
    [isUser, snapshot, picked, picks, id, name, sobject]
  );

  return (
    <TicksContext.Provider value={ticks}>
      <div className="record-tree">
        <BelongsTo object={sobject} id={id} onOpen={onOpen} />
        <p className="muted help">
          {isUser
            ? 'Tick the access that goes with this user to another org. Missing permission sets and groups are created there.'
            : 'Tick what to copy: a relationship takes all its records, ▸ opens it to pick some. Only what is ticked is copied.'}
        </p>
        {error && <p className="bad">❌ {error}</p>}
        <ul className="relation-tree root">
          {isUser ? (
            <li>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picks.has(`rec:${id}`)}
                  onChange={(e) =>
                    ticks.set(`rec:${id}`, e.target.checked ? { object: sobject, where: `Id = '${id}'` } : null)
                  }
                />{' '}
                <b>{name || id}</b>
              </label>
              {!snapshot ? (
                <p className="muted">Reading the user's access…</p>
              ) : (
                <AccessTree snapshot={snapshot} picked={picked} setPicked={setPicked} />
              )}
            </li>
          ) : (
            <RecordNode object={sobject} id={id} name={name} root />
          )}
        </ul>
        <CopyBar what={what} />
      </div>
    </TicksContext.Provider>
  );
}
