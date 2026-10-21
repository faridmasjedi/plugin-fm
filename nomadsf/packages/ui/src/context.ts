import { createContext, useContext } from 'react';
import type { SalesforceClient, UserInfo } from '@nomadsf/core';
import type { OrgChoice, OrgFacts } from './host';

export type Studio = {
  /** app: inside `sf fm dashboard` (CLI login, local repository); extension: browser session only. */
  hostKind: 'app' | 'extension';
  client: SalesforceClient;
  org: OrgChoice;
  facts?: OrgFacts;
  user?: UserInfo;
  /** Asks before running code or changing anything in a production org. */
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
