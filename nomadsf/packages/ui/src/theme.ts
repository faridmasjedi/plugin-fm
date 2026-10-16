import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const listeners = new Set<() => void>();
const media = window.matchMedia('(prefers-color-scheme: dark)');

function stored(): Theme | null {
  try {
    const value = localStorage.getItem('nomadsf.theme');
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return stored() ?? (media.matches ? 'dark' : 'light');
}

function apply(): void {
  document.documentElement.dataset.theme = currentTheme();
  listeners.forEach((l) => l());
}

media.addEventListener('change', apply);
apply();

export function toggleTheme(): void {
  try {
    localStorage.setItem('nomadsf.theme', currentTheme() === 'dark' ? 'light' : 'dark');
  } catch {
    // ignore: the toggle still applies for this page
  }
  apply();
}

export function useTheme(): Theme {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, currentTheme);
}
