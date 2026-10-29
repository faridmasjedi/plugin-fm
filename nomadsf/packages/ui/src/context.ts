import { createContext, useContext } from 'react';
import type { MigrateObject, SalesforceClient, UserCopy, UserInfo } from '@nomadsf/core';
import type { HostKind, OrgChoice, OrgFacts } from './host';

export type Studio = {
  /** app: inside `sf fm dashboard` (CLI login, local repository); extension: browser session only. */
  hostKind: HostKind;
  client: SalesforceClient;
  org: OrgChoice;
  /** Every org you can switch to (browser logins in the extension, CLI orgs in the app). */
  orgs: OrgChoice[];
  /** A connection to any org of the list, e.g. to compare with another org. */
  clientFor: (id: string) => Promise<SalesforceClient>;
  facts?: OrgFacts;
  user?: UserInfo;
  /** Asks before running code, tests, debug logging or Log in as (in any org; production with a warning). */
  confirmRisky: (what: string) => Promise<boolean>;
  /** Data and access changes: the person types the org name to confirm (any org). */
  confirmChange: (what: string) => Promise<boolean>;
  /** Records a change in this browser's activity log. */
  logActivity: (action: string, details: Record<string, unknown>) => void;
};

export type ActivityEntry = { at: string; org: string; user: string; action: string; details: Record<string, unknown> };

export const activityLog = {
  list(): ActivityEntry[] {
    return storage.get<ActivityEntry[]>('activity', []);
  },
  add(entry: ActivityEntry): void {
    storage.set('activity', [entry, ...activityLog.list()].slice(0, 300));
  },
  clear(): void {
    storage.set('activity', []);
  },
};

export const StudioContext = createContext<Studio | null>(null);

/** Opens a record in the Record inspector (from any table with Ids). */
export const InspectContext = createContext<((id: string) => void) | null>(null);

/** Shows another tool (Query, Migrate…) in the active pane. */
export const GoContext = createContext<((tool: string) => void) | null>(null);

let pendingFile: File | null = null;

/** Work handed to another tool: Query gets a SOQL, Migrate a basket (records, users) or a saved one. */
export const handoff = {
  query(soql: string): void {
    storage.set('query.soql', soql);
    storage.set('query.tooling', false);
    window.dispatchEvent(new CustomEvent('nomadsf:query', { detail: soql }));
  },
  /** Exactly these records (nothing related brought along), and users with the access picked. */
  migrate(org: string, objects: MigrateObject[], users: UserCopy[] = []): void {
    storage.set('migrate.plan', { org, objects, users });
    window.dispatchEvent(new Event('nomadsf:migrate-plan'));
  },
  /** A saved basket (workbook) for Migrate › From files. */
  migrateFile(file: File): void {
    pendingFile = file;
    window.dispatchEvent(new Event('nomadsf:migrate-file'));
  },
  hasFile(): boolean {
    return pendingFile !== null;
  },
  takeFile(): File | null {
    const file = pendingFile;
    pendingFile = null;
    return file;
  },
};

export function useStudio(): Studio {
  const studio = useContext(StudioContext);
  if (!studio) throw new Error('No org selected.');
  return studio;
}

/** localStorage helpers that never throw (private windows, blocked storage). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const value = localStorage.getItem(`nomadsf.${key}`);
      return value === null ? fallback : (JSON.parse(value) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`nomadsf.${key}`, JSON.stringify(value));
    } catch {
      // ignore
    }
  },
};
