import type { Envelope, RunEvent, Warning } from '@promptlens/contracts';

export const CORE_UNREACHABLE = 'INTEGRATION_CORE_UNREACHABLE';

export class CoreApiError extends Error {
  code: string;
  retryable: boolean;
  scope: string;
  remediation?: string;
  details?: unknown;
  traceId?: string;
  status: number;
  requestId?: string;

  constructor(error: {
    code: string;
    message: string;
    retryable?: boolean;
    scope?: string;
    remediation?: string;
    details?: unknown;
    traceId?: string;
    status?: number;
    requestId?: string;
  }) {
    super(error.message);
    this.name = 'CoreApiError';
    this.code = error.code;
    this.retryable = Boolean(error.retryable);
    this.scope = error.scope ?? 'system';
    this.remediation = error.remediation;
    this.details = error.details;
    this.traceId = error.traceId;
    this.status = error.status ?? 0;
    this.requestId = error.requestId;
  }
}

export interface CoreClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  onWarnings?: (warnings: Warning[], path: string) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class CoreClient {
  baseUrl: string;
  token: string;
  private fetchImpl: typeof fetch;
  private onWarnings?: (warnings: Warning[], path: string) => void;

  constructor(options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onWarnings = options.onWarnings;
  }

  withToken(token: string, baseUrl?: string) {
    return new CoreClient({
      baseUrl: baseUrl ?? this.baseUrl,
      token,
      fetchImpl: this.fetchImpl,
      onWarnings: this.onWarnings,
    });
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl || 'http://127.0.0.1');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return this.baseUrl ? url.toString() : `${url.pathname}${url.search}`;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new CoreApiError({
        code: CORE_UNREACHABLE,
        message: '无法连接本地核心服务，请确认 PromptLens 已启动。',
        retryable: true,
        scope: 'system',
        remediation: '点击重试；若持续失败，重启桌面应用以重新拉起核心服务。',
        details: { cause: (error as Error)?.message },
      });
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new CoreApiError({
        code: 'INTERNAL_UNEXPECTED',
        message: `核心服务返回了非 JSON 响应（HTTP ${response.status}）。`,
        status: response.status,
        retryable: false,
        scope: 'system',
      });
    }
    if (!envelope.ok || !response.ok) {
      throw new CoreApiError({
        code: envelope.error?.code ?? 'INTERNAL_UNEXPECTED',
        message: envelope.error?.message ?? `请求失败（HTTP ${response.status}）。`,
        retryable: envelope.error?.retryable,
        scope: envelope.error?.scope,
        remediation: envelope.error?.remediation,
        details: envelope.error?.details,
        traceId: envelope.meta?.traceId,
        requestId: envelope.requestId,
        status: response.status,
      });
    }
    if (envelope.warnings?.length) this.onWarnings?.(envelope.warnings, path);
    return envelope.data as T;
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}

export interface RunEventStreamOptions {
  projectId: string;
  runId: string;
  afterSeq?: number;
  signal?: AbortSignal;
  onEvent: (event: RunEvent) => void;
  onEnd?: (status: string) => void;
  onError?: (error: Error) => void;
}

/**
 * 基于 fetch 的 SSE：可携带 Authorization 头，支持 afterSeq 断线补齐。
 * 返回取消函数；收到 event:end 或连接结束后自动停止重连。
 */
export function streamRunEvents(client: CoreClient, options: RunEventStreamOptions): () => void {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let closed = false;

  const run = async () => {
    let lastSeq = options.afterSeq ?? 0;
    let retry = 1000;
    let attempts = 0;
    while (!closed) {
      try {
        const response = await fetch(
          client.buildUrl(`/v1/projects/${options.projectId}/runs/${options.runId}/events`, { afterSeq: lastSeq }),
          {
            headers: { Authorization: `Bearer ${client.token}`, Accept: 'text/event-stream' },
            signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new CoreApiError({
            code: 'INTEGRATION_CORE_UNREACHABLE',
            message: `事件流不可用（HTTP ${response.status}）。`,
            retryable: true,
            scope: 'system',
          });
        }
        attempts = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (!frame.trim() || frame.startsWith(':')) continue;
            const dataLines: string[] = [];
            let eventName = 'message';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
              else if (line.startsWith('retry:')) retry = Number(line.slice(6).trim()) || retry;
            }
            if (!dataLines.length) continue;
            const payload = JSON.parse(dataLines.join('\n'));
            if (eventName === 'end') {
              closed = true;
              options.onEnd?.(payload.status);
              controller.abort();
              return;
            }
            const event = payload as RunEvent;
            if (event.seq > lastSeq) lastSeq = event.seq;
            options.onEvent(event);
          }
        }
      } catch (error) {
        if (closed || (error as Error)?.name === 'AbortError') return;
        options.onError?.(error as Error);
      }
      if (closed) return;
      attempts += 1;
      const wait = Math.min(30_000, retry * 2 ** Math.min(attempts, 5));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };

  void run();
  return () => {
    closed = true;
    controller.abort();
  };
}
