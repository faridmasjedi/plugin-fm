import { useEffect, useState } from 'react';
import type { BasketItem } from '@nomadsf/core';
import { storage } from './context';

/** The records picked on Record › Related, per org, kept in this browser until emptied. */
const key = (org: string): string => `basket.${org}`;
const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());

export const basket = {
  get(org: string): BasketItem[] {
    return storage.get<BasketItem[]>(key(org), []);
  },
  add(org: string, items: BasketItem[]): void {
    const now = basket.get(org);
    storage.set(key(org), [...now, ...items.filter((i) => !now.some((x) => x.id === i.id))]);
    changed();
  },
  remove(org: string, ids: string[]): void {
    storage.set(
      key(org),
      basket.get(org).filter((x) => !ids.includes(x.id))
    );
    changed();
  },
  clear(org: string): void {
    storage.set(key(org), []);
    changed();
  },
};

export function useBasket(org: string): BasketItem[] {
  const [items, setItems] = useState(() => basket.get(org));
  useEffect(() => {
    const update = () => setItems(basket.get(org));
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, [org]);
  return items;
}
