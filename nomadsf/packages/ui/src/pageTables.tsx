import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { makeZip, toCsv } from '@nomadsf/core';

/**
 * Every table on a page, for one download of all of them (the ⤓ of a pane): each DataTable
 * registers what it shows (filters and sorting applied); only tables on screen are taken.
 */

type Row = Record<string, unknown>;
export type PageTable = { name: string; columns: string[]; rows: Row[] };
type Entry = { read: () => PageTable; element: RefObject<HTMLElement | null> };

export class PageTables {
  private readonly entries = new Set<Entry>();

  public add(entry: Entry): () => void {
    this.entries.add(entry);
    return () => this.entries.delete(entry);
  }

  /** The tables on screen, in page order. */
  public visible(): PageTable[] {
    return [...this.entries]
      .filter((e) => e.element.current && e.element.current.offsetParent !== null)
      .sort((a, b) =>
        a.element.current!.compareDocumentPosition(b.element.current!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      .map((e) => e.read());
  }
}

const Context = createContext<PageTables | null>(null);

export function PageTablesProvider({ tables, children }: { tables: PageTables; children: ReactNode }) {
  return <Context.Provider value={tables}>{children}</Context.Provider>;
}

/** A DataTable on the page: what it shows now is in the page's download. */
export function useRegisterTable(element: RefObject<HTMLElement | null>, read: () => PageTable): void {
  const tables = useContext(Context);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => tables?.add({ read: () => latest.current(), element }), [tables, element]);
}

const fileName = (name: string): string => name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'table';

/** A zip with one CSV per table (with a byte-order mark, so Excel reads accents). */
export function tablesZip(tables: PageTable[]): Uint8Array {
  const seen = new Map<string, number>();
  return makeZip(
    tables.map((t, i) => {
      const base = fileName(t.name);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return {
        path: `${String(i + 1).padStart(2, '0')}-${base}${n > 1 ? `-${n}` : ''}.csv`,
        content: `﻿${toCsv(t.columns, t.rows)}`,
      };
    })
  );
}
