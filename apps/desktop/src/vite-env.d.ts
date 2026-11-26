/// <reference types="vite/client" />

declare const __PROMPTLENS_DEV__: { baseUrl: string; token: string } | null;

interface Window {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: {
    core?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  };
}
