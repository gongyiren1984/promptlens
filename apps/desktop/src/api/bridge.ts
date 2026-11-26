import { CORE_UNREACHABLE, CoreApiError, CoreClient } from '@promptlens/api-client';
import type { Warning } from '@promptlens/contracts';

let cached: { baseUrl: string; token: string } | null = null;
let pending: Promise<{ baseUrl: string; token: string }> | null = null;
let warningHandler: ((warnings: Warning[]) => void) | null = null;
let clientPromise: Promise<CoreClient> | null = null;

export function setWarningHandler(handler: ((warnings: Warning[]) => void) | null) {
  warningHandler = handler;
}

async function resolveAuth() {
  if (cached) return cached;
  if (!pending) {
    pending = (async () => {
      if (window.__TAURI_INTERNALS__) {
        const { invoke } = await import('@tauri-apps/api/core');
        const endpoint = await invoke<{ endpoint: string; token: string }>('core_endpoint');
        cached = { baseUrl: endpoint.endpoint, token: endpoint.token };
        return cached;
      }
      if (__PROMPTLENS_DEV__) {
        cached = { baseUrl: __PROMPTLENS_DEV__.baseUrl, token: __PROMPTLENS_DEV__.token };
        return cached;
      }
      throw new CoreApiError({
        code: CORE_UNREACHABLE,
        message: '未检测到桌面壳或开发令牌。',
        retryable: true,
        scope: 'system',
        remediation: '请通过 npm run dev 启动开发服务，或在桌面应用中打开。',
      });
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

export function getClient(): Promise<CoreClient> {
  if (!clientPromise) {
    clientPromise = resolveAuth().then(
      (auth) =>
        new CoreClient({
          baseUrl: auth.baseUrl,
          token: auth.token,
          onWarnings: (warnings) => warningHandler?.(warnings),
        }),
    );
  }
  return clientPromise;
}

export function resetClient() {
  cached = null;
  clientPromise = null;
}

/** 桌面壳内打开原生目录选择器；浏览器开发模式下返回 null，由调用方降级为手输路径。 */
export async function pickDirectory(): Promise<string | null> {
  if (!window.__TAURI_INTERNALS__) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('pick_directory');
}
