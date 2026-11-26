import { useEffect, useState, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'promptlens.theme';
const CHANGE_EVENT = 'promptlens:theme-change';
const listeners = new Set<() => void>();

export function readThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function writeThemePreference(value: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, value);
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  const handler = () => callback();
  window.addEventListener('storage', handler);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', handler);
    window.removeEventListener(CHANGE_EVENT, handler);
  };
}

export function useThemePreference(): [ThemePreference, (value: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribe, readThemePreference, () => 'system' as ThemePreference);
  return [preference, writeThemePreference];
}

/** 跟随系统深浅色；监听器保证系统切换在 1 秒内生效。 */
export function useSystemLight(): boolean {
  const [light, setLight] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (event: MediaQueryListEvent) => setLight(event.matches);
    media.addEventListener('change', handler);
    setLight(media.matches);
    return () => media.removeEventListener('change', handler);
  }, []);
  return light;
}
