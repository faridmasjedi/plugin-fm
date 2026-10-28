import { useSyncExternalStore } from 'react';
import type { Transport } from '@nomadsf/core';

/**
 * Requests to Salesforce in flight, for the "working" spinner in the header. Streaming's long
 * polls (CometD) wait on purpose and are not counted. The spinner stays a moment after the
 * last answer, so jobs that poll every few seconds do not flicker.
 */
let inFlight = 0;
let shown = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const set = (next: boolean): void => {
  if (next === shown) return;
  shown = next;
  listeners.forEach((l) => l());
};

const change = (delta: number): void => {
  inFlight += delta;
  if (inFlight > 0) {
    clearTimeout(hideTimer);
    set(true);
  } else {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => set(false), 1500);
  }
};

/** The same transport, counted while it waits for Salesforce. */
export function tracked(transport: Transport): Transport {
  return async (request) => {
    if (request.path.includes('/cometd/')) return transport(request);
    change(1);
    try {
      return await transport(request);
    } finally {
      change(-1);
    }
  };
}

export function useBusy(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown
  );
}
