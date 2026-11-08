import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from './storage';

export type ThemeMode = 'light' | 'dark' | 'system';
const KEY = 'nv.theme';
const subs = new Set<() => void>();
let mode: ThemeMode = readLocal<ThemeMode>(KEY, 'system');

const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');
export const resolveDark = (m: ThemeMode, systemDark: boolean) => (m === 'system' ? systemDark : m === 'dark');
const isDarkNow = () => resolveDark(mode, media()?.matches ?? false);

function apply(): void {
  document.documentElement.classList.toggle('dark', isDarkNow());
  for (const s of subs) s();
}

export function initTheme(): void {
  apply();
  media()?.addEventListener?.('change', apply);
}

export function setThemeMode(m: ThemeMode): void {
  mode = m;
  writeLocal(KEY, m);
  apply();
}

export const cycleTheme = () => setThemeMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system');

const subscribe = (s: () => void) => {
  subs.add(s);
  return () => subs.delete(s);
};
export const useThemeMode = () => useSyncExternalStore(subscribe, () => mode);
export const useIsDark = () => useSyncExternalStore(subscribe, isDarkNow);
export const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' };
