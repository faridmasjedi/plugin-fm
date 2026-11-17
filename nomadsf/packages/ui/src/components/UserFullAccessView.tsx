import { useContext, useEffect, useState } from 'react';
import { userFullAccess, userRecordSharing, type AccessHolder, type Row, type UserAccessSection } from '@nomadsf/core';
import { GoContext, storage, useStudio } from '../context';
import { TableTabs } from './TableTabs';
import { DataTable, EmptyHint } from './DataTable';
import { Status } from '../statusLog';

/** Rows grouped by object in these sections (a box per object, opened like a dropdown). */
const BY_OBJECT = new Set(['fields', 'recordTypes', 'layouts']);

/**
 * Users › a user › Access: everything the user can do, combined from the profile, permission sets and permission
 * set groups (objects, fields, classes, pages, custom permissions, apps, tabs, record types, layouts), each row
 * saying where it comes from; and Shared records: per object, what they own and what is shared with them.
 */
export function UserFullAccessView({ userId, label }: { userId: string; label: string }) {
  const { client } = useStudio();
  const go = useContext(GoContext);
  const [data, setData] = useState<{ holders: AccessHolder[]; sections: UserAccessSection[] } | null>(null);
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState(() => storage.get('user.access.tab', 'objects'));
  const [sharing, setSharing] = useState<(UserAccessSection & { notes: string[] }) | null>(null);
  const [sharingStatus, setSharingStatus] = useState('');

  useEffect(() => {
    let canceled = false;
    setData(null);
    setSharing(null);
    setSharingStatus('');
    setStatus('Reading the profile, permission sets and groups…');
    userFullAccess(client, userId)
      .then((d) => {
        if (canceled) return;
        setData(d);
        setStatus('');
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, userId]);

  // Shared records counts records object by object: read only when its tab is opened
  const objects = data?.sections.find((s) => s.id === 'objects')?.rows;
  useEffect(() => {
    if (tab !== 'sharing' || !objects || sharing || sharingStatus) return;
    let canceled = false;
    setSharingStatus('Counting records owned and shared, object by object…');
    userRecordSharing(client, userId, objects)
      .then((s) => {
        if (canceled) return;
        setSharing(s);
        setSharingStatus('');
      })
      .catch((e: Error) => !canceled && setSharingStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, objects, client, userId]);

  if (!data) return <Status text={status} block />;
  if (!data.holders.length) return <EmptyHint what="profile or permission sets" />;
  const table = (s: UserAccessSection, note: string) =>
    s.note ? (
      <p className="bad-text">
        Could not read {s.title.toLowerCase()}: {s.note}
      </p>
    ) : s.rows.length === 0 ? (
      <p className="muted">None.</p>
    ) : (
      <DataTable
        columns={s.columns}
        rows={s.rows.map((r, i) => ({ ...r, __key: i }))}
        rowKey="__key"
        groupBy={BY_OBJECT.has(s.id) ? 'Object' : undefined}
        name={`${label}-${s.title}`}
        note={<span>· {note}</span>}
      />
    );
  const NOTES: Record<string, string> = {
    objects: 'Via says which source gives what',
    fields: 'Read or Edit per field (required fields are always readable, so not listed)',
    classes: 'Apex classes they may run (Visualforce, Lightning and REST)',
    pages: 'Visualforce pages they may open',
    customPermissions: 'custom permissions they have',
    apps: 'apps in their App Launcher',
    connectedApps: 'connected apps they are pre-authorized for',
    tabs: 'the most visible setting wins',
    recordTypes: 'record types they may create; Default comes from the profile',
    layouts: 'the page layout they see, by object and record type (from the profile)',
  };
  return (
    <div className="user-full-access">
      <div className="access-sources">
        <span className="muted small">From</span>
        {data.holders.map((h) => (
          <span key={h.id} className={`pill source-${h.kind}`}>
            {h.via}
          </span>
        ))}
      </div>
      <TableTabs
        active={tab}
        onChange={(id) => {
          setTab(id);
          storage.set('user.access.tab', id);
        }}
        tabs={[
          ...data.sections.map((s) => ({
            id: s.id,
            label: s.title,
            count: s.note ? undefined : s.rows.length,
            content: table(s, NOTES[s.id] ?? ''),
          })),
          {
            id: 'sharing',
            label: 'Shared records',
            count: sharing ? sharing.rows.length : undefined,
            content: (
              <div className="shared-records">
                <p className="muted">
                  Per object they can read: the org-wide default, the records they own, and the records shared with them
                  — directly, through their groups and queues, or through their role — and why. A record shared more
                  than one way counts once per way. Salesforce works out the rest when they open a record (managers
                  above them see it too):{' '}
                  {go && (
                    <button className="link" onClick={() => go('whocansee')}>
                      Who can see a record →
                    </button>
                  )}
                </p>
                {!sharing ? (
                  <Status text={sharingStatus || 'Reading…'} block />
                ) : (
                  <>
                    {sharing.notes.length > 0 && <p className="muted small">{sharing.notes.join(' · ')}</p>}
                    {table(sharing, 'record counts')}
                  </>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/** The access sheets of a user for the Everything workbook (Shared records left out: it counts every object). */
export async function userAccessSheets(
  client: Parameters<typeof userFullAccess>[0],
  userId: string
): Promise<Array<{ name: string; columns: string[]; rows: Row[] }>> {
  const { sections } = await userFullAccess(client, userId);
  return sections.map((s) => ({
    name: `Access - ${s.title}`.slice(0, 31),
    columns: s.columns,
    rows: s.note ? [{ [s.columns[0]]: `Not read: ${s.note}` }] : s.rows,
  }));
}
