import { createContext, useContext } from 'react';
import type { SalesforceClient, UserInfo } from '@nomadsf/core';
import type { OrgChoice, OrgFacts } from './host';

export type Studio = {
  client: SalesforceClient;
  org: OrgChoice;
  facts?: OrgFacts;
  user?: UserInfo;
  /** Asks before running code or changing anything in a production org. */
  confirmRisky: (what: string) => boolean;
};

export const StudioContext = createContext<Studio | null>(null);

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
