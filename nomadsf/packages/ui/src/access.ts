import { useEffect, useState } from 'react';
import { myAccess, type MyAccess, type SalesforceClient } from '@nomadsf/core';

/** The logged-in user's access in an org, checked once per connection. */
const checked = new WeakMap<SalesforceClient, Promise<MyAccess>>();

export function accessOf(client: SalesforceClient): Promise<MyAccess> {
  let p = checked.get(client);
  if (!p) {
    p = myAccess(client);
    checked.set(client, p);
  }
  return p;
}

export function useAccessOf(client: SalesforceClient | null | undefined): MyAccess | null {
  const [access, setAccess] = useState<MyAccess | null>(null);
  useEffect(() => {
    setAccess(null);
    if (!client) return;
    let canceled = false;
    void accessOf(client).then((a) => !canceled && setAccess(a));
    return () => {
      canceled = true;
    };
  }, [client]);
  return access;
}

/** Why changing permissions in this org is not possible (or undefined when it may be). */
export const cannotChangePermissions = (access: MyAccess | null, org: string): string | undefined =>
  access?.known && !access.can.changePermissions
    ? `Your user can't change permissions in ${org} (needs Manage Profiles and Permission Sets).`
    : undefined;
