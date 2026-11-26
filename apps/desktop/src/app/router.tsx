import { useSyncExternalStore } from 'react';

export interface RouteState {
  path: string;
  name: string;
  params: Record<string, string>;
}

const PATTERNS: Array<{ name: string; segments: string[] }> = [
  { name: 'workspace', segments: [] },
  { name: 'onboarding', segments: ['onboarding'] },
  { name: 'models', segments: ['models'] },
  { name: 'settings', segments: ['settings'] },
  { name: 'about', segments: ['about'] },
  { name: 'privacy', segments: ['legal', 'privacy'] },
  { name: 'terms', segments: ['legal', 'terms'] },
  { name: 'notices', segments: ['legal', 'notices'] },
  { name: 'project', segments: ['projects', ':projectId'] },
  { name: 'prompts', segments: ['projects', ':projectId', 'prompts'] },
  { name: 'cases', segments: ['projects', ':projectId', 'cases'] },
  { name: 'evalProfiles', segments: ['projects', ':projectId', 'eval-profiles'] },
  { name: 'suggestions', segments: ['projects', ':projectId', 'suggestions'] },
  { name: 'wizard', segments: ['projects', ':projectId', 'experiments', 'new'] },
  { name: 'runs', segments: ['projects', ':projectId', 'runs'] },
  { name: 'run', segments: ['projects', ':projectId', 'runs', ':runId'] },
  { name: 'compare', segments: ['projects', ':projectId', 'runs', ':runId', 'compare'] },
  { name: 'analytics', segments: ['projects', ':projectId', 'analytics'] },
  { name: 'reports', segments: ['projects', ':projectId', 'reports'] },
];

const listeners = new Set<() => void>();

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  const handler = () => callback();
  window.addEventListener('hashchange', handler);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('hashchange', handler);
  };
}

export function navigate(to: string) {
  if (currentPath() === to) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return false;
  }
  window.location.hash = to;
  return true;
}

function match(path: string): RouteState {
  const parts = path.split('/').filter(Boolean);
  for (const pattern of PATTERNS) {
    if (pattern.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let index = 0; index < parts.length; index++) {
      const expected = pattern.segments[index];
      if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(parts[index]);
      else if (expected !== parts[index]) {
        ok = false;
        break;
      }
    }
    if (ok) return { path, name: pattern.name, params };
  }
  return { path, name: 'not-found', params: {} };
}

export function useRoute(): RouteState {
  const path = useSyncExternalStore(subscribe, currentPath, () => '/');
  return match(path);
}

export function Link({
  to,
  children,
  className,
  onClick,
  ariaCurrent,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  ariaCurrent?: boolean;
}) {
  return (
    <a
      href={`#${to}`}
      className={className}
      aria-current={ariaCurrent ? 'page' : undefined}
      onClick={(event) => {
        onClick?.();
        if (currentPath() === to) {
          event.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }}
    >
      {children}
    </a>
  );
}

export function projectPath(projectId: string, suffix = '') {
  return `/projects/${encodeURIComponent(projectId)}${suffix}`;
}
